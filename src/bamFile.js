const { unzip } = require('@gmod/bgzf-filehandle')
const { CSI } = require('@gmod/tabix')
const LRU = require('lru-cache')

const BAI = require('./bai')
const LocalFile = require('./localFile')
const BAMFeature = require('./record')
const { parseHeaderText } = require('./sam')

const BAM_MAGIC = 21840194

class CSIEnhanced extends CSI {
  constructor(args) {
    super(args)
    this.store = args.store
  }
  async parse() {
    const ret = await super.parse()
    if (this.refNameToId) ret.refNameToId = this.refNameToId
    return ret
  }
}

const blockLen = 1 << 16

class BamFile {
  /**
   * @param {object} args
   * @param {string} [args.bamPath]
   * @param {FileHandle} [args.bamFilehandle]
   * @param {string} [args.baiPath]
   * @param {FileHandle} [args.baiFilehandle]
   */
  constructor({
    bamFilehandle,
    bamPath,
    baiPath,
    baiFilehandle,
    csiPath,
    csiFilehandle,
    cacheSize,
    fetchSizeLimit,
    chunkSizeLimit,
    renameRefSeqs = n => n,
  }) {
    this.renameRefSeq = renameRefSeqs

    if (bamFilehandle) {
      this.bam = bamFilehandle
    } else if (bamPath) {
      this.bam = new LocalFile(bamPath)
    }

    if (csiFilehandle) {
      this.index = new CSIEnhanced({ filehandle: csiFilehandle, store: this })
    } else if (csiPath) {
      this.index = new CSIEnhanced({
        filehandle: new LocalFile(csiPath),
        store: this,
      })
    } else if (baiFilehandle) {
      this.index = new BAI({ filehandle: baiFilehandle })
    } else if (baiPath) {
      this.index = new BAI({ filehandle: new LocalFile(baiPath) })
    } else {
      this.index = new BAI({ filehandle: new LocalFile(`${bamPath}.bai`) })
    }

    this.featureCache = LRU({
      max: cacheSize !== undefined ? cacheSize : 20000,
      length: featureArray => featureArray.length,
    })

    this.fetchSizeLimit = fetchSizeLimit || 50000000
    this.chunkSizeLimit = chunkSizeLimit || 10000000
  }

  async getHeader() {
    const indexData = await this.index.parse()
    const ret = indexData.firstDataLine
      ? indexData.firstDataLine.blockPosition + 65535
      : undefined
    let buf
    if (ret) {
      buf = Buffer.alloc(ret + blockLen)
      const bytesRead = await this.bam.read(buf, 0, ret + blockLen, 0)
      if (bytesRead < ret) {
        buf = buf.slice(0, bytesRead)
      } else {
        buf = buf.slice(0, ret)
      }
    } else {
      buf = await this.bam.readFile()
    }

    const uncba = await unzip(buf)

    if (uncba.readInt32LE(0) !== BAM_MAGIC) throw new Error('Not a BAM file')
    const headLen = uncba.readInt32LE(4)

    this.header = uncba.toString('utf8', 8, 8 + headLen)
    await this._readRefSeqs(headLen + 8, 65535)
    this.index.refNameToId = this.chrToIndex

    return parseHeaderText(this.header)
  }

  // the full length of the refseq block is not given in advance so this grabs a chunk and
  // doubles it if all refseqs haven't been processed
  async _readRefSeqs(start, refSeqBytes) {
    let buf = Buffer.alloc(refSeqBytes + blockLen)
    const bytesRead = await this.bam.read(buf, 0, refSeqBytes + blockLen)
    if (bytesRead < refSeqBytes) {
      buf = buf.slice(0, bytesRead)
    } else {
      buf = buf.slice(0, refSeqBytes)
    }
    const uncba = await unzip(buf)
    const nRef = uncba.readInt32LE(start)
    let p = start + 4
    const chrToIndex = {}
    const indexToChr = []
    for (let i = 0; i < nRef; i += 1) {
      const lName = uncba.readInt32LE(p)
      let refName = uncba.toString('utf8', p + 4, p + 4 + lName - 1)
      refName = this.renameRefSeq(refName)
      const lRef = uncba.readInt32LE(p + lName + 4)

      chrToIndex[refName] = i
      indexToChr.push({ refName, length: lRef })

      p = p + 8 + lName
      if (p > uncba.length) {
        console.warn(
          `BAM header is very big.  Re-fetching ${refSeqBytes} bytes.`,
        )
        return this._readRefSeqs(start, refSeqBytes * 2)
      }
    }
    this.chrToIndex = chrToIndex
    this.indexToChr = indexToChr
    return { chrToIndex, indexToChr }
  }

  async getRecordsForRange(chr, min, max) {
    // todo regularize refseq names
    const chrId = this.chrToIndex && this.chrToIndex[chr]
    let chunks
    if (!(chrId >= 0)) {
      chunks = []
    } else {
      chunks = await this.index.blocksForRange(chrId, min - 1, max)

      if (!chunks) {
        throw new Error('Error in index fetch')
      }
    }
    for (let i = 0; i < chunks.length; i += 1) {
      const size = chunks[i].fetchedSize()
      if (size > this.chunkSizeLimit) {
        throw new Error(
          `Too many BAM features. BAM chunk size ${size} bytes exceeds chunkSizeLimit of ${
            this.chunkSizeLimit
          }`,
        )
      }
    }

    const totalSize = chunks
      .map(s => s.fetchedSize())
      .reduce((a, b) => a + b, 0)
    if (totalSize > this.fetchSizeLimit)
      throw new Error(
        `data size of ${totalSize.toLocaleString()} bytes exceeded fetch size limit of ${this.fetchSizeLimit.toLocaleString()} bytes`,
      )

    return this._fetchChunkFeatures(chunks, chrId, min, max)
  }

  async _fetchChunkFeatures(chunks, chrId, min, max) {
    const recordPromises = []
    const featPromises = []
    chunks.forEach(c => {
      let recordPromise = this.featureCache.get(c.toString())
      if (!recordPromise) {
        recordPromise = this._readChunk(c)
        this.featureCache.set(c.toString(), recordPromise)
      }
      recordPromises.push(recordPromise)
      const featPromise = recordPromise.then(
        f => {
          const recs = []
          for (let i = 0; i < f.length; i += 1) {
            const feature = f[i]
            if (feature._refID === chrId) {
              // on the right ref seq
              if (feature.get('start') >= max)
                // past end of range, can stop iterating
                break
              else if (feature.get('end') >= min) {
                // must be in range
                recs.push(feature)
              }
            }
          }
          return recs
        },
        e => {
          console.error(e)
        },
      )
      featPromises.push(featPromise)
    })
    const recs = await Promise.all(featPromises)
    return [].concat(...recs)
  }

  async _readChunk(chunk) {
    const bufsize = chunk.fetchedSize()
    let buf = Buffer.alloc(bufsize + blockLen)
    const bytesRead = await this.bam.read(
      buf,
      0,
      bufsize + blockLen,
      chunk.minv.blockPosition,
    )
    if (bytesRead < bufsize) {
      buf = buf.slice(0, bytesRead)
    } else {
      buf = buf.slice(0, bufsize)
    }

    const data = await unzip(buf)
    return this.readBamFeatures(data, chunk.minv.dataPosition)
  }

  readBamFeatures(ba, blockStart) {
    const sink = []

    while (blockStart < ba.length) {
      const blockSize = ba.readInt32LE(blockStart, true)
      const blockEnd = blockStart + 4 + blockSize - 1

      // only try to read the feature if we have all the bytes for it
      if (blockEnd < ba.length) {
        const feature = new BAMFeature({
          bytes: { byteArray: ba, start: blockStart, end: blockEnd },
        })
        sink.push(feature)
      }

      blockStart = blockEnd + 1
    }
    return sink
  }

  hasRefSeq(seqId) {
    return this.index.hasRefSeq(seqId)
  }
}

module.exports = BamFile
