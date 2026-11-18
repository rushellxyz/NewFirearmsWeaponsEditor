"use strict";

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    for (let bit = 0; bit < 8; bit++) index = index & 1 ? (index >>> 1) ^ 0xedb88320 : index >>> 1;
    return index;
});

function zipHeader(length, signature) {
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    const word = (index, number) => view.setUint16(index, number, true);
    const long = (index, number) => view.setUint32(index, number, true);
    long(0, signature);
    return { bytes, word, long };
}

async function exportZip(workspace) {
    const chunks = [], directory = [];
    let offset = 0, directorySize = 0, count = 0;
    for await (const path of workspace.files()) {
        const file = await workspace.folder.read(path);
        const name = new TextEncoder().encode(path);
        if (name.length > 65535 || file.size >= 0xffffffff || count >= 65535 ||
            offset + directorySize + file.size + 2 * name.length + 110 >= 0xffffffff)
            throw new Error("The folder is too large to export as a standard ZIP.");
        let checksum = 0xffffffff;
        for await (const chunk of file.stream()) {
            for (const byte of chunk) checksum = (checksum >>> 8) ^ crcTable[(checksum ^ byte) & 255];
        }
        checksum = (checksum ^ 0xffffffff) >>> 0;
        const local = zipHeader(30, 0x04034b50);
        local.word(4, 20);
        local.word(6, 0x0800);
        local.word(12, 33);
        local.long(14, checksum);
        local.long(18, file.size);
        local.long(22, file.size);
        local.word(26, name.length);
        chunks.push(local.bytes, name, file);
        const central = zipHeader(46, 0x02014b50);
        central.word(4, 20);
        central.word(6, 20);
        central.word(8, 0x0800);
        central.word(14, 33);
        central.long(16, checksum);
        central.long(20, file.size);
        central.long(24, file.size);
        central.word(28, name.length);
        central.long(42, offset);
        directory.push(central.bytes, name);
        offset += 30 + name.length + file.size;
        directorySize += 46 + name.length;
        count++;
    }
    const end = zipHeader(22, 0x06054b50);
    end.word(8, count);
    end.word(10, count);
    end.long(12, directorySize);
    end.long(16, offset);
    return new Blob([...chunks, ...directory, end.bytes], { type: "application/zip" });
}
