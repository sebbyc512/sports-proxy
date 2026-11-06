// Minimal ZIP reader (no dependency added -- MoneyPuck's season files are small, single- or
// few-entry zips). Supports the two compression methods ZIP actually uses for this kind of
// archive: 0 (stored, no compression) and 8 (deflate). Reads the local file headers
// directly rather than walking the central directory -- robust enough for these files and
// avoids needing the end-of-central-directory record's exact offset math.
import { inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER_SIG = 0x04034b50;

export function unzipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === LOCAL_FILE_HEADER_SIG) {
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const raw = buffer.subarray(dataStart, dataEnd);

    let data;
    if (compressionMethod === 0) data = Buffer.from(raw);
    else if (compressionMethod === 8) data = inflateRawSync(raw);
    else throw new Error(`unzipEntries: unsupported compression method ${compressionMethod} for ${name}`);

    entries.push({ name, data });
    offset = dataEnd;
  }
  return entries;
}
