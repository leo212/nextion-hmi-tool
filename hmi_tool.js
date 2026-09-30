#!/usr/bin/env node
/**
 * ============================================================================
 * Nextion HMI Visual Layout & Asset Manager (Nextion HMI Tool)
 * 
 * Provides human-readable, lossless bidirectional YAML & Asset export/import
 * for Nextion .HMI project files without requiring Nextion Editor GUI.
 * 
 * Features:
 *   - Export HMI into per-page YAMLs, pictures.yaml, and PNG image assets.
 *   - In-place property patching (coordinates, colors, fonts, texts, pics).
 *   - Dynamic component injection (add new buttons, texts, pictures, hotspots).
 *   - Custom picture asset injection & replacement (pure Node.js RGB565 encoder).
 *   - Complete CRC calculation engine (page CRC, table ADEC CRC, main.HMI CRC).
 *   - Non-destructive: always produces a new HMI file, preserves untouched bytes.
 * 
 * Commands:
 *   node hmi_tool.js export <project.HMI> [output_directory]
 *   node hmi_tool.js import <project_directory> [output.HMI]
 * 
 * License: MIT
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// ============================================================================
// Nextion CRC32 Engine (IEEE 802.3 MSB-first, Polynomial 0x04C11DB7)
// ============================================================================

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let crc = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
        crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04C11DB7 : 0)) >>> 0;
    }
    CRC_TABLE[i] = crc >>> 0;
}

function nextionCrcUpdate(crc, buf) {
    let c = crc >>> 0;
    for (let i = 0; i < buf.length; i++) {
        c = (c ^ buf[i]) >>> 0;
        for (let r = 0; r < 4; r++) {
            c = ((c << 8) ^ CRC_TABLE[c >>> 24]) >>> 0;
        }
    }
    return c >>> 0;
}

/**
 * Computes the 32-bit CRC for the internal main.HMI metadata file.
 */
function computeNextionMainHmiCrc(mainHmiBuf) {
    let c = nextionCrcUpdate(0xffffffff, mainHmiBuf.subarray(4));
    c = nextionCrcUpdate(c, mainHmiBuf.subarray(16, 20)); // offset 16 (0x10), len 4
    c = nextionCrcUpdate(c, mainHmiBuf.subarray(4, 8));   // offset 4  (0x04), len 4
    c = nextionCrcUpdate(c, mainHmiBuf.subarray(10, 11)); // offset 10 (0x0a), len 1
    c = nextionCrcUpdate(c, mainHmiBuf.subarray(14, 15)); // offset 14 (0x0e), len 1
    return c >>> 0;
}

/**
 * Computes the 32-bit CRC for a page (.pa) file.
 */
function computeNextionPageCrc(pageBuf) {
    let c = nextionCrcUpdate(0xffffffff, pageBuf.slice(4));
    c = nextionCrcUpdate(c, pageBuf.slice(4, 8));       // datasize
    c = nextionCrcUpdate(c, pageBuf.slice(12, 16));     // numberobj
    c = nextionCrcUpdate(c, pageBuf.slice(0x14, 0x15)); // byte 0x14
    c = nextionCrcUpdate(c, pageBuf.slice(0x15, 0x16)); // byte 0x15
    return c >>> 0;
}

/**
 * Computes the 32-bit archive directory table CRC ("ADEC" keyed).
 */
function computeTableCrc(tableBufWithCount) {
    let c = 0xffffffff;
    const dwordCount = Math.floor(tableBufWithCount.length / 4);
    for (let i = 0; i < dwordCount; i++) {
        const dw = tableBufWithCount.readUInt32LE(i * 4);
        c = (c ^ dw) >>> 0;
        for (let r = 0; r < 4; r++) {
            c = ((c << 8) ^ CRC_TABLE[c >>> 24]) >>> 0;
        }
    }
    const adec = Buffer.from('ADEC', 'ascii');
    const dw = adec.readUInt32LE(0);
    c = (c ^ dw) >>> 0;
    for (let r = 0; r < 4; r++) {
        c = ((c << 8) ^ CRC_TABLE[c >>> 24]) >>> 0;
    }
    return c >>> 0;
}

function syncArchiveDirectoryTables(buffer) {
    const count = buffer.readUInt32LE(0);
    if (count > 0 && count < 10000) {
        const tableLen = 4 + count * 28;
        const tableBuf = buffer.slice(0, tableLen);
        const crc = computeTableCrc(tableBuf);
        buffer.writeUInt32LE(crc, tableLen);
        if (buffer.length >= 0x80000 + tableLen + 4) {
            buffer.copy(buffer, 0x80000, 0, tableLen + 4);
        }
    }
}

function recalculateAllPageCrcs(buffer) {
    const count = buffer.readUInt32LE(0);
    let patched = 0;
    if (count > 0 && count < 10000) {
        let pos = 4;
        for (let i = 0; i < count; i++) {
            const name = buffer.toString('latin1', pos, pos + 16).replace(/\0.*$/, '');
            const start = buffer.readUInt32LE(pos + 16);
            const size = buffer.readUInt32LE(pos + 20);
            if (name.endsWith('.pa')) {
                const pageBuf = buffer.slice(start, start + size);
                const newCrc = computeNextionPageCrc(pageBuf);
                buffer.writeUInt32LE(newCrc, start);
                patched++;
            }
            pos += 28;
        }
    }
    syncArchiveDirectoryTables(buffer);
    return patched;
}

// ============================================================================
// Pure Node.js PNG & RGB565 Image Decoder & Encoders
// ============================================================================

function decodePngToRgb565(pngBuf) {
    let offset = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idatParts = [];

    while (offset < pngBuf.length) {
        const chunkLen = pngBuf.readUInt32BE(offset);
        const chunkType = pngBuf.toString('ascii', offset + 4, offset + 8);
        const chunkData = pngBuf.subarray(offset + 8, offset + 8 + chunkLen);
        offset += 12 + chunkLen;

        if (chunkType === 'IHDR') {
            width = chunkData.readUInt32BE(0);
            height = chunkData.readUInt32BE(4);
            bitDepth = chunkData[8];
            colorType = chunkData[9];
        } else if (chunkType === 'IDAT') {
            idatParts.push(chunkData);
        } else if (chunkType === 'IEND') {
            break;
        }
    }

    if (!width || !height) throw new Error('Invalid PNG format or missing IHDR');

    const decompressed = zlib.inflateSync(Buffer.concat(idatParts));
    let bpp = 3;
    if (colorType === 6) bpp = 4;
    else if (colorType === 2) bpp = 3;
    else if (colorType === 0) bpp = 1;
    else if (colorType === 4) bpp = 2;

    const stride = width * bpp;
    const rgb565Buf = Buffer.alloc(width * height * 2);
    const prevRow = Buffer.alloc(stride);
    const curRow = Buffer.alloc(stride);

    let srcPos = 0;
    for (let y = 0; y < height; y++) {
        const filterType = decompressed[srcPos++];
        for (let i = 0; i < stride; i++) {
            const rawByte = decompressed[srcPos++];
            const a = i >= bpp ? curRow[i - bpp] : 0;
            const b = prevRow[i];
            const c = i >= bpp ? prevRow[i - bpp] : 0;

            let val = 0;
            if (filterType === 0) val = rawByte;
            else if (filterType === 1) val = (rawByte + a) & 0xff;
            else if (filterType === 2) val = (rawByte + b) & 0xff;
            else if (filterType === 3) val = (rawByte + Math.floor((a + b) / 2)) & 0xff;
            else if (filterType === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                let pr = a;
                if (pb < pa && pb <= pc) pr = b;
                else if (pc < pa) pr = c;
                val = (rawByte + pr) & 0xff;
            }
            curRow[i] = val;
        }

        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0;
            if (bpp === 4) {
                r = curRow[x * 4];
                g = curRow[x * 4 + 1];
                b = curRow[x * 4 + 2];
            } else if (bpp === 3) {
                r = curRow[x * 3];
                g = curRow[x * 3 + 1];
                b = curRow[x * 3 + 2];
            } else {
                r = g = b = curRow[x * bpp];
            }

            const r5 = (r >> 3) & 0x1f;
            const g6 = (g >> 2) & 0x3f;
            const b5 = (b >> 3) & 0x1f;
            const rgb565 = (r5 << 11) | (g6 << 5) | b5;
            rgb565Buf.writeUInt16LE(rgb565, (y * width + x) * 2);
        }
        curRow.copy(prevRow);
    }

    return { width, height, rgb565Buf };
}

function buildIsBuffer(pngBuf, width, height) {
    const header = Buffer.alloc(27);
    header.set([0x0a, 0x64, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x1b, 0x00, 0x00, 0x00]);
    header.writeUInt16LE(width, 0x0c);
    header.writeUInt16LE(height, 0x0e);
    header.writeUInt32LE(pngBuf.length, 0x10);
    header.write('png', 0x18, 3, 'ascii');
    return Buffer.concat([header, pngBuf]);
}

function buildIBuffer(rgb565Buf, width, height) {
    const header = Buffer.alloc(24);
    header.set([0x0a, 0x64, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00]);
    header.writeUInt16LE(width, 0x0c);
    header.writeUInt16LE(height, 0x0e);
    const dataSize = 20 + rgb565Buf.length;
    header.writeUInt32LE(dataSize, 0x10);
    const mode0Padding = Buffer.alloc(20);
    return Buffer.concat([header, mode0Padding, rgb565Buf]);
}

// ============================================================================
// Record-Level Component Parser & Serializer
// ============================================================================

function parseComponentRecords(compBuf) {
    let p = 0;
    const attLen = compBuf.readUInt32LE(p);
    const attName = compBuf.slice(p + 4, p + 4 + attLen).toString('ascii');
    p += 4 + attLen;
    const records = [];
    while (p < compBuf.length) {
        const recLen = compBuf.readUInt32LE(p);
        const data = compBuf.slice(p + 4, p + 4 + recLen);
        records.push(data);
        p += 4 + recLen;
        if (recLen === 0) break;
    }
    return { attName, records };
}

function serializeComponentRecords(attName, records) {
    let totalLen = 4 + attName.length;
    for (const r of records) totalLen += 4 + r.length;
    const buf = Buffer.alloc(totalLen);
    buf.writeUInt32LE(attName.length, 0);
    buf.write(attName, 4, 'ascii');
    let p = 4 + attName.length;
    for (const r of records) {
        buf.writeUInt32LE(r.length, p);
        r.copy(buf, p + 4);
        p += 4 + r.length;
    }
    return buf;
}

function setComponentProp(parsed, propName, valBuffer) {
    const padName = Buffer.alloc(16, 0);
    padName.write(propName, 0, 'ascii');
    let found = false;
    for (let i = 0; i < parsed.records.length; i++) {
        const r = parsed.records[i];
        if (r.length >= 16 && r.slice(0, 16).equals(padName)) {
            parsed.records[i] = Buffer.concat([padName, valBuffer]);
            found = true;
            break;
        }
    }
    if (!found) {
        const newRec = Buffer.concat([padName, valBuffer]);
        let insIdx = parsed.records.length;
        for (let i = 0; i < parsed.records.length; i++) {
            const s = parsed.records[i].toString('ascii');
            if (s.startsWith('codes') || parsed.records[i].length === 0) {
                insIdx = i;
                break;
            }
        }
        parsed.records.splice(insIdx, 0, newRec);
    }
}

function setPropU8(parsed, name, val) {
    const b = Buffer.alloc(1);
    b.writeUInt8(val & 0xFF, 0);
    setComponentProp(parsed, name, b);
}
function setPropU16(parsed, name, val) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(val & 0xFFFF, 0);
    setComponentProp(parsed, name, b);
}
function setPropU32(parsed, name, val) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(val >>> 0, 0);
    setComponentProp(parsed, name, b);
}
function setPropI32(parsed, name, val) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(val | 0, 0);
    setComponentProp(parsed, name, b);
}
function setPropStr(parsed, name, str) {
    let s = String(str);
    if (name === 'txt') {
        // Nextion text components require CRLF (\r\n) for line breaks
        s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
    }
    const b = Buffer.from(s, 'utf8');
    setComponentProp(parsed, name, b);
}

function updateComponentFromYaml(parsed, yComp) {
    const x = yComp.x !== undefined ? yComp.x : null;
    const y = yComp.y !== undefined ? yComp.y : null;
    const w = yComp.w !== undefined ? yComp.w : null;
    const h = yComp.h !== undefined ? yComp.h : null;

    if (x !== null && typeof x === 'number') setPropU16(parsed, 'x', x);
    if (y !== null && typeof y === 'number') setPropU16(parsed, 'y', y);
    if (w !== null && typeof w === 'number') setPropU16(parsed, 'w', w);
    if (h !== null && typeof h === 'number') setPropU16(parsed, 'h', h);
    if (x !== null && w !== null && typeof x === 'number' && typeof w === 'number') {
        setPropU16(parsed, 'endx', x + w - 1);
    }
    if (y !== null && h !== null && typeof y === 'number' && typeof h === 'number') {
        setPropU16(parsed, 'endy', y + h - 1);
    }

    if (yComp.txt !== undefined) {
        setPropStr(parsed, 'txt', yComp.txt);
        const crlfStr = String(yComp.txt).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
        setPropU16(parsed, 'txt_maxl', Math.max(Buffer.byteLength(crlfStr, 'utf8'), 20));
    }
    if (yComp.font !== undefined && typeof yComp.font === 'number') setPropU8(parsed, 'font', yComp.font);
    if (yComp.pco !== undefined && typeof yComp.pco === 'number') setPropU16(parsed, 'pco', yComp.pco);
    if (yComp.pco2 !== undefined && typeof yComp.pco2 === 'number') setPropU16(parsed, 'pco2', yComp.pco2);
    if (yComp.bco !== undefined && typeof yComp.bco === 'number') setPropU16(parsed, 'bco', yComp.bco);
    if (yComp.bco2 !== undefined && typeof yComp.bco2 === 'number') setPropU16(parsed, 'bco2', yComp.bco2);
    if (yComp.sta !== undefined && typeof yComp.sta === 'number') setPropU8(parsed, 'sta', yComp.sta);
    if (yComp.xcen !== undefined && typeof yComp.xcen === 'number') setPropU8(parsed, 'xcen', yComp.xcen);
    if (yComp.ycen !== undefined && typeof yComp.ycen === 'number') setPropU8(parsed, 'ycen', yComp.ycen);
    if (yComp.pic !== undefined && yComp.pic !== 65535 && typeof yComp.pic === 'number') setPropU16(parsed, 'pic', yComp.pic);
    if (yComp.picc !== undefined && yComp.picc !== 65535 && typeof yComp.picc === 'number') setPropU16(parsed, 'picc', yComp.picc);

    // Variables & Timers
    if (yComp.vscope !== undefined) {
        let vs = 0;
        if (typeof yComp.vscope === 'string') {
            vs = yComp.vscope.toLowerCase() === 'global' ? 1 : 0;
        } else {
            vs = Number(yComp.vscope) ? 1 : 0;
        }
        setPropU8(parsed, 'vscope', vs);
    }
    if (yComp.var_type !== undefined) {
        const vt = String(yComp.var_type).toLowerCase();
        setPropU8(parsed, 'sta', (vt === 'string' || vt === 'txt') ? 1 : 0);
    }
    if (yComp.val !== undefined && typeof yComp.val === 'number') {
        setPropI32(parsed, 'val', yComp.val);
    }
    if (yComp.txt_maxl !== undefined && typeof yComp.txt_maxl === 'number') {
        setPropU16(parsed, 'txt_maxl', yComp.txt_maxl);
    }
    if (yComp.tim !== undefined && typeof yComp.tim === 'number') {
        setPropU16(parsed, 'tim', yComp.tim);
    }
    if (yComp.en !== undefined) {
        setPropU8(parsed, 'en', yComp.en ? 1 : 0);
    }
}

function getComponentEvents(attName) {
    if (attName === 'att-28') return ['codesload', 'codesloadend', 'codesdown', 'codesup', 'codesunload'];
    if (attName === 'att-9' || attName === 'att-35') return ['codestimer'];
    if (attName === 'att-11') return [];
    return ['codesdown', 'codesup'];
}

function normalizeEventName(key) {
    const k = key.toLowerCase().replace(/[-_]/g, '');
    if (k === 'codesdown' || k === 'down' || k === 'touchpress' || k === 'press') return 'codesdown';
    if (k === 'codesup' || k === 'up' || k === 'touchrelease' || k === 'release') return 'codesup';
    if (k === 'codestimer' || k === 'timer' || k === 'tick') return 'codestimer';
    if (k === 'codesload' || k === 'load' || k === 'preinit') return 'codesload';
    if (k === 'codesloadend' || k === 'loadend' || k === 'postinit') return 'codesloadend';
    if (k === 'codesunload' || k === 'unload' || k === 'exit' || k === 'leave') return 'codesunload';
    return key;
}

function extractPropertiesAndScripts(parsed) {
    const propRecords = [];
    const scripts = {};

    let i = 0;
    while (i < parsed.records.length) {
        const r = parsed.records[i];
        if (r.length === 0) {
            i++;
            break;
        }
        const s = r.toString('ascii');
        const match = s.match(/^(codes[a-z]+)-(\d+)$/);
        if (match) {
            const evtName = match[1];
            const lineCount = parseInt(match[2], 10);
            const lines = [];
            for (let k = 0; k < lineCount; k++) {
                i++;
                if (i < parsed.records.length) {
                    lines.push(parsed.records[i].toString('utf8'));
                }
            }
            if (lines.length > 0) {
                scripts[evtName] = lines.join('\n');
            }
        } else {
            propRecords.push(r);
        }
        i++;
    }

    return { propRecords, scripts };
}

function rebuildRecordsWithScripts(attName, propRecords, scripts) {
    const newRecords = [...propRecords];
    const evts = getComponentEvents(attName);

    const normalizedScripts = {};
    if (scripts && typeof scripts === 'object') {
        for (const [k, v] of Object.entries(scripts)) {
            normalizedScripts[normalizeEventName(k)] = v;
        }
    }

    for (const evt of evts) {
        const scriptContent = normalizedScripts[evt];
        if (scriptContent !== undefined && scriptContent !== null && String(scriptContent).trim().length > 0) {
            const lines = String(scriptContent).split(/\r?\n/).filter(l => l.trim().length > 0);
            while (lines.length > 0 && lines[lines.length - 1] === '') {
                lines.pop();
            }
            newRecords.push(Buffer.from(`${evt}-${lines.length}`, 'ascii'));
            for (const line of lines) {
                newRecords.push(Buffer.from(line, 'utf8'));
            }
        } else {
            newRecords.push(Buffer.from(`${evt}-0`, 'ascii'));
        }
    }
    newRecords.push(Buffer.alloc(0));
    return newRecords;
}

function createDefaultVariableTemplate() {
    const records = [];
    const pad = (s) => {
        const b = Buffer.alloc(16, 0);
        b.write(s, 0, 'ascii');
        return b;
    };
    records.push(Buffer.concat([pad('type'), Buffer.from([0x34])]));
    records.push(Buffer.concat([pad('id'), Buffer.from([0x00])]));
    records.push(Buffer.concat([pad('objname'), Buffer.from('va0', 'ascii')]));
    records.push(Buffer.concat([pad('vscope'), Buffer.from([0x00])]));
    records.push(Buffer.concat([pad('lockobj'), Buffer.from([0x00])]));
    records.push(Buffer.concat([pad('groupid0'), Buffer.alloc(4, 0)]));
    records.push(Buffer.concat([pad('groupid1'), Buffer.alloc(4, 0)]));
    records.push(Buffer.concat([pad('sta'), Buffer.from([0x00])]));
    records.push(Buffer.concat([pad('txt'), Buffer.alloc(0)]));
    const maxlBuf = Buffer.alloc(2);
    maxlBuf.writeUInt16LE(10, 0);
    records.push(Buffer.concat([pad('txt_maxl'), maxlBuf]));
    records.push(Buffer.concat([pad('val'), Buffer.alloc(4, 0)]));
    records.push(Buffer.alloc(0));
    return serializeComponentRecords('att-11', records);
}

function createDefaultTimerTemplate() {
    const records = [];
    const pad = (s) => {
        const b = Buffer.alloc(16, 0);
        b.write(s, 0, 'ascii');
        return b;
    };
    records.push(Buffer.concat([pad('type'), Buffer.from([0x33])]));
    records.push(Buffer.concat([pad('id'), Buffer.from([0x00])]));
    records.push(Buffer.concat([pad('objname'), Buffer.from('tm0', 'ascii')]));
    records.push(Buffer.concat([pad('vscope'), Buffer.from([0x00])]));
    records.push(Buffer.concat([pad('lockobj'), Buffer.from([0x00])]));
    records.push(Buffer.concat([pad('groupid0'), Buffer.alloc(4, 0)]));
    records.push(Buffer.concat([pad('groupid1'), Buffer.alloc(4, 0)]));
    const timBuf = Buffer.alloc(2);
    timBuf.writeUInt16LE(50, 0);
    records.push(Buffer.concat([pad('tim'), timBuf]));
    records.push(Buffer.concat([pad('en'), Buffer.from([0x00])]));
    records.push(Buffer.from('codestimer-0', 'ascii'));
    records.push(Buffer.alloc(0));
    return serializeComponentRecords('att-9', records);
}

function findTemplateInHmi(buffer, targetAtt) {
    const count = buffer.readUInt32LE(0);
    for (let i = 0; i < count; i++) {
        const pos = 4 + i * 28;
        const name = buffer.toString('latin1', pos, pos + 16).replace(/\0.*$/, '');
        const start = buffer.readUInt32LE(pos + 16);
        const size = buffer.readUInt32LE(pos + 20);
        if (name.endsWith('.pa')) {
            const pa = buffer.slice(start, start + size);
            const nObj = pa.readUInt32LE(12);
            for (let j = 0; j < nObj; j++) {
                const rel = pa.readUInt32LE(56 + j * 12);
                const len = pa.readUInt32LE(56 + j * 12 + 4);
                const comp = pa.slice(56 + rel, 56 + rel + len);
                const aLen = comp.readUInt32LE(0);
                if (comp.slice(4, 4 + aLen).toString('ascii') === targetAtt) {
                    return comp;
                }
            }
        }
    }
    return null;
}

function patchPage(hmiBuf, pageData) {
    const pageName = pageData.name;
    const count = hmiBuf.readUInt32LE(0);
    let targetEntry = null;
    for (let i = 0; i < count; i++) {
        const pos = 4 + i * 28;
        const name = hmiBuf.toString('ascii', pos, pos + 16).replace(/\0.*$/, '');
        const start = hmiBuf.readUInt32LE(pos + 16);
        const size = hmiBuf.readUInt32LE(pos + 20);
        if (name.endsWith('.pa')) {
            const paName = hmiBuf.toString('ascii', start + 0x18, start + 0x28).replace(/\0.*$/, '');
            if (paName.toLowerCase() === pageName.toLowerCase() || (count === 4 && name === '0.pa')) {
                targetEntry = { index: i, pos, name, start, size };
                break;
            }
        }
    }

    if (!targetEntry) {
        console.warn(`[WARN] Page "${pageName}" not found in HMI archive table.`);
        return hmiBuf;
    }

    const oldPa = hmiBuf.slice(targetEntry.start, targetEntry.start + targetEntry.size);
    const oldNumObj = oldPa.readUInt32LE(12);

    const compBodies = [];
    const compMap = new Map(); // objname -> index in compBodies

    for (let j = 0; j < oldNumObj; j++) {
        const rel = oldPa.readUInt32LE(56 + j * 12);
        const len = oldPa.readUInt32LE(56 + j * 12 + 4);
        const cb = oldPa.slice(56 + rel, 56 + rel + len);
        compBodies.push(cb);

        const attLen = cb.readUInt32LE(0);
        let p = 4 + attLen;
        while (p < cb.length) {
            const rLen = cb.readUInt32LE(p);
            p += 4;
            if (rLen === 0) break;
            const rData = cb.slice(p, p + rLen);
            p += rLen;
            if (rData.length >= 16 && rData.slice(0, 7).toString('ascii') === 'objname') {
                const name = rData.slice(16).toString('ascii').replace(/\0.*$/, '');
                compMap.set(name, j);
                break;
            }
        }
    }

    let updatedCount = 0;
    let newCount = 0;

    for (const yComp of pageData.components) {
        if (yComp.objname && Buffer.byteLength(yComp.objname, 'utf8') > 14) {
            throw new Error(`[ERROR] Component objname "${yComp.objname}" exceeds Nextion maximum allowed length of 14 bytes (${Buffer.byteLength(yComp.objname, 'utf8')} bytes).`);
        }
        if (compMap.has(yComp.objname)) {
            const j = compMap.get(yComp.objname);
            const parsed = parseComponentRecords(compBodies[j]);
            updateComponentFromYaml(parsed, yComp);
            if (yComp.scripts) {
                const { propRecords } = extractPropertiesAndScripts(parsed);
                parsed.records = rebuildRecordsWithScripts(parsed.attName, propRecords, yComp.scripts);
            }
            compBodies[j] = serializeComponentRecords(parsed.attName, parsed.records);
            updatedCount++;
        } else {
            let targetAtt = 'att-39'; // default text
            const typeLower = (yComp.type || '').toLowerCase();
            if (typeLower === 'button' || typeLower === 'att-42' || (!yComp.type && yComp.objname.startsWith('b'))) targetAtt = 'att-42';
            else if (typeLower === 'text' || typeLower === 'att-39' || (!yComp.type && yComp.objname.startsWith('t'))) targetAtt = 'att-39';
            else if (typeLower === 'picture' || typeLower === 'pic' || typeLower === 'att-22' || (!yComp.type && yComp.objname.startsWith('p'))) targetAtt = 'att-22';
            else if (typeLower === 'hotspot' || typeLower === 'att-21' || typeLower === 'att-8' || (!yComp.type && yComp.objname.startsWith('m'))) targetAtt = 'att-21';
            else if (typeLower === 'variable' || typeLower === 'var' || typeLower === 'att-11' || (!yComp.type && yComp.objname.startsWith('va_'))) targetAtt = 'att-11';
            else if (typeLower === 'timer' || typeLower === 'tm' || typeLower === 'att-9' || typeLower === 'att-35' || (!yComp.type && yComp.objname.startsWith('tm_'))) targetAtt = 'att-9';

            let templateBuf = compBodies.find(cb => {
                const aLen = cb.readUInt32LE(0);
                return cb.slice(4, 4 + aLen).toString('ascii') === targetAtt;
            });
            if (!templateBuf) templateBuf = findTemplateInHmi(hmiBuf, targetAtt);
            if (!templateBuf) {
                if (targetAtt === 'att-11') templateBuf = createDefaultVariableTemplate();
                else if (targetAtt === 'att-9') templateBuf = createDefaultTimerTemplate();
                else templateBuf = compBodies[compBodies.length - 1];
            }

            const parsed = parseComponentRecords(templateBuf);
            const { propRecords } = extractPropertiesAndScripts(parsed);
            parsed.records = propRecords;

            const newId = compBodies.length;
            setPropU8(parsed, 'id', newId);
            setPropStr(parsed, 'objname', yComp.objname);
            updateComponentFromYaml(parsed, yComp);

            parsed.records = rebuildRecordsWithScripts(parsed.attName, parsed.records, yComp.scripts || {});

            const newCompBuf = serializeComponentRecords(parsed.attName, parsed.records);
            compMap.set(yComp.objname, compBodies.length);
            compBodies.push(newCompBuf);
            newCount++;
            console.log(`[IMPORT] Created new component "${yComp.objname}" (type: ${yComp.type || targetAtt}) on page "${pageName}".`);
        }
    }

    if (updatedCount > 0) {
        console.log(`[IMPORT] Updated ${updatedCount} existing components on page "${pageName}".`);
    }

    const newNumObj = compBodies.length;
    const tableSize = newNumObj * 12;
    let bodiesTotal = 0;
    for (const b of compBodies) bodiesTotal += b.length;
    const newPaSize = 56 + tableSize + bodiesTotal;
    const newPa = Buffer.alloc(newPaSize);

    oldPa.copy(newPa, 0, 0, 56);
    newPa.writeUInt32LE(newPaSize, 4);
    newPa.writeUInt32LE(newNumObj, 12);

    let rel = tableSize;
    for (let j = 0; j < newNumObj; j++) {
        const e = 56 + j * 12;
        newPa.writeUInt32LE(rel, e);
        newPa.writeUInt32LE(compBodies[j].length, e + 4);
        newPa.writeUInt32LE(0, e + 8);
        compBodies[j].copy(newPa, 56 + rel);
        rel += compBodies[j].length;
    }

    const crc = computeNextionPageCrc(newPa);
    newPa.writeUInt32LE(crc, 0);

    const delta = newPa.length - targetEntry.size;
    let newHmi = hmiBuf;
    if (delta !== 0) {
        newHmi = Buffer.alloc(hmiBuf.length + delta);
        hmiBuf.copy(newHmi, 0, 0, targetEntry.start);
        newPa.copy(newHmi, targetEntry.start);
        hmiBuf.copy(newHmi, targetEntry.start + newPa.length, targetEntry.start + targetEntry.size);

        const entryCount = newHmi.readUInt32LE(0);
        for (let i = 0; i < entryCount; i++) {
            const pos = 4 + i * 28;
            const start = newHmi.readUInt32LE(pos + 16);
            if (pos === targetEntry.pos) {
                newHmi.writeUInt32LE(newPa.length, pos + 20);
            } else if (start > targetEntry.start) {
                newHmi.writeUInt32LE(start + delta, pos + 16);
            }
        }
    } else {
        newPa.copy(newHmi, targetEntry.start);
    }

    syncArchiveDirectoryTables(newHmi);
    return newHmi;
}

// ============================================================================
// HMI Scanner & Layout Extractor
// ============================================================================

function scanHmi(buffer) {
    const count = buffer.readUInt32LE(0);
    const pages = [];
    if (count > 0 && count < 10000) {
        let dirPos = 4;
        for (let i = 0; i < count; i++) {
            const name = buffer.toString('latin1', dirPos, dirPos + 16).replace(/\0.*$/, '');
            const start = buffer.readUInt32LE(dirPos + 16);
            const size = buffer.readUInt32LE(dirPos + 20);
            if (name.endsWith('.pa')) {
                const pageBuf = buffer.slice(start, start + size);
                const pageName = pageBuf.toString('ascii', 0x18, 0x28).replace(/\0.*$/, '');
                const numObj = pageBuf.readUInt32LE(12);
                const curPage = {
                    name: pageName,
                    entry: name,
                    offset: start,
                    size,
                    components: []
                };

                for (let j = 0; j < numObj; j++) {
                    const entryOff = 56 + j * 12;
                    const rel = pageBuf.readUInt32LE(entryOff);
                    const compSize = pageBuf.readUInt32LE(entryOff + 4);
                    const compStart = 56 + rel;
                    const compSlice = pageBuf.slice(compStart, compStart + compSize);

                    const attLen = compSlice.length >= 4 ? compSlice.readUInt32LE(0) : 0;
                    let typeName = undefined;
                    let rawAtt = '';
                    if (attLen > 0 && attLen <= 16 && compSlice.length >= 4 + attLen) {
                        rawAtt = compSlice.slice(4, 4 + attLen).toString('ascii');
                        if (rawAtt === 'att-39') typeName = 'text';
                        else if (rawAtt === 'att-42') typeName = 'button';
                        else if (rawAtt === 'att-22') typeName = 'picture';
                        else if (rawAtt === 'att-28') typeName = 'page';
                        else if (rawAtt === 'att-8' || rawAtt === 'att-21' || rawAtt === 'att-33') typeName = 'hotspot';
                        else if (rawAtt === 'att-41') typeName = 'gauge';
                        else if (rawAtt === 'att-30') typeName = 'progress';
                        else if (rawAtt === 'att-34') typeName = 'slider';
                        else if (rawAtt === 'att-35' || rawAtt === 'att-9') typeName = 'timer';
                        else if (rawAtt === 'att-11') typeName = 'variable';
                    }

                    const parsedRecords = parseComponentRecords(compSlice);
                    const { scripts } = extractPropertiesAndScripts(parsedRecords);

                    const comp = {
                        index: j,
                        type: typeName,
                        attName: rawAtt,
                        offset: start + compStart,
                        size: compSize,
                        propOffsets: {},
                        scripts: Object.keys(scripts).length > 0 ? scripts : undefined
                    };

                    let p = 4 + attLen;
                    while (p < compSlice.length) {
                        const recLen = compSlice.readUInt32LE(p);
                        const rec = compSlice.slice(p + 4, p + 4 + recLen);
                        p += 4 + recLen;

                        if (rec.length >= 16) {
                            const propName = rec.slice(0, 16).toString('ascii').replace(/\0.*$/, '');
                            const valBuf = rec.slice(16);
                            const valAbsOff = start + compStart + (p - recLen) + 16;
                            comp.propOffsets[propName] = valAbsOff;

                            if (propName === 'objname') comp.objname = valBuf.toString('ascii').replace(/\0.*$/, '');
                            else if (propName === 'x' && valBuf.length >= 2) comp.x = valBuf.readUInt16LE(0);
                            else if (propName === 'y' && valBuf.length >= 2) comp.y = valBuf.readUInt16LE(0);
                            else if (propName === 'w' && valBuf.length >= 2) comp.w = valBuf.readUInt16LE(0);
                            else if (propName === 'h' && valBuf.length >= 2) comp.h = valBuf.readUInt16LE(0);
                            else if (propName === 'txt') comp.txt = valBuf.toString('utf8').replace(/\0.*$/, '');
                            else if (propName === 'font' && valBuf.length >= 1) comp.font = valBuf.readUInt8(0);
                            else if (propName === 'pco' && valBuf.length >= 2) comp.pco = valBuf.readUInt16LE(0);
                            else if (propName === 'bco' && valBuf.length >= 2) comp.bco = valBuf.readUInt16LE(0);
                            else if (propName === 'pic' && valBuf.length >= 2) comp.pic = valBuf.readUInt16LE(0);
                            else if (propName === 'picc' && valBuf.length >= 2) comp.picc = valBuf.readUInt16LE(0);
                            else if (propName === 'sta' && valBuf.length >= 1) comp.sta = valBuf.readUInt8(0);
                            else if (propName === 'xcen' && valBuf.length >= 1) comp.xcen = valBuf.readUInt8(0);
                            else if (propName === 'ycen' && valBuf.length >= 1) comp.ycen = valBuf.readUInt8(0);
                            else if (propName === 'vscope' && valBuf.length >= 1) comp.vscope = valBuf.readUInt8(0);
                            else if (propName === 'val' && valBuf.length >= 4) comp.val = valBuf.readInt32LE(0);
                            else if (propName === 'txt_maxl' && valBuf.length >= 2) comp.txt_maxl = valBuf.readUInt16LE(0);
                            else if (propName === 'tim' && valBuf.length >= 2) comp.tim = valBuf.readUInt16LE(0);
                            else if (propName === 'en' && valBuf.length >= 1) comp.en = valBuf.readUInt8(0);
                        }
                        if (recLen === 0) break;
                    }

                    if (!comp.objname) comp.objname = `obj_${j}`;
                    curPage.components.push(comp);
                }
                pages.push(curPage);
            }
            dirPos += 28;
        }
    }
    return pages;
}

function pageToYaml(page, scriptsDirRel, scriptsDirAbs) {
    const lines = [];
    lines.push(`# Page: ${page.name}`);
    lines.push(`page: "${page.name}"`);
    lines.push('components:');
    for (const comp of page.components) {
        lines.push(`  - objname: "${comp.objname}"`);
        if (comp.type) lines.push(`    type: "${comp.type}"`);

        if (comp.type === 'variable') {
            lines.push(`    vscope: "${comp.vscope === 1 ? 'global' : 'local'}"`);
            lines.push(`    var_type: "${comp.sta === 1 ? 'string' : 'number'}"`);
            if (comp.sta === 1) {
                if (comp.txt !== undefined) {
                    const cleanTxt = comp.txt
                        .replace(/\r\n\n/g, '\n')
                        .replace(/\r\n/g, '\n')
                        .replace(/\r/g, '\n');
                    lines.push(`    txt: "${cleanTxt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
                }
                if (comp.txt_maxl !== undefined) lines.push(`    txt_maxl: ${comp.txt_maxl}`);
            } else {
                lines.push(`    val: ${comp.val !== undefined ? comp.val : 0}`);
            }
        } else if (comp.type === 'timer') {
            if (comp.vscope !== undefined) lines.push(`    vscope: "${comp.vscope === 1 ? 'global' : 'local'}"`);
            if (comp.tim !== undefined) lines.push(`    tim: ${comp.tim}`);
            if (comp.en !== undefined) lines.push(`    en: ${comp.en}`);
        } else {
            if (comp.x !== undefined) lines.push(`    x: ${comp.x}`);
            if (comp.y !== undefined) lines.push(`    y: ${comp.y}`);
            if (comp.w !== undefined) lines.push(`    w: ${comp.w}`);
            if (comp.h !== undefined) lines.push(`    h: ${comp.h}`);
            if (comp.txt !== undefined) {
                const cleanTxt = comp.txt
                    .replace(/\r\n\n/g, '\n')
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n');
                lines.push(`    txt: "${cleanTxt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
            }
            if (comp.font !== undefined) lines.push(`    font: ${comp.font}`);
            if (comp.pco !== undefined) lines.push(`    pco: ${comp.pco}`);
            if (comp.pco2 !== undefined) lines.push(`    pco2: ${comp.pco2}`);
            if (comp.bco !== undefined) lines.push(`    bco: ${comp.bco}`);
            if (comp.bco2 !== undefined) lines.push(`    bco2: ${comp.bco2}`);
            if (comp.pic !== undefined && comp.pic !== 65535) lines.push(`    pic: ${comp.pic}`);
            if (comp.picc !== undefined && comp.picc !== 65535) lines.push(`    picc: ${comp.picc}`);
            if (comp.sta !== undefined) lines.push(`    sta: ${comp.sta}`);
            if (comp.xcen !== undefined) lines.push(`    xcen: ${comp.xcen}`);
            if (comp.ycen !== undefined) lines.push(`    ycen: ${comp.ycen}`);
        }

        if (comp.scripts && Object.keys(comp.scripts).length > 0) {
            lines.push('    scripts:');
            for (const [evt, scriptCode] of Object.entries(comp.scripts)) {
                if (scriptsDirAbs && scriptsDirRel) {
                    fs.mkdirSync(scriptsDirAbs, { recursive: true });
                    const scriptFileName = `${comp.objname}.${evt}.js`;
                    const scriptFilePath = path.join(scriptsDirAbs, scriptFileName);
                    let fileCode = scriptCode;
                    const headerComment = '// Nextion Display Script (Nextion instruction set syntax, not standard JavaScript)\n';
                    if (!fileCode.startsWith('// Nextion Display Script')) {
                        fileCode = headerComment + fileCode;
                    }
                    fs.writeFileSync(scriptFilePath, fileCode, 'utf8');
                    const scriptRelPath = path.join(scriptsDirRel, scriptFileName).replace(/\\/g, '/');
                    lines.push(`      ${evt}: "${scriptRelPath}"`);
                } else {
                    lines.push(`      ${evt}: |`);
                    for (const sLine of scriptCode.split(/\r?\n/)) {
                        lines.push(`        ${sLine}`);
                    }
                }
            }
        }

        lines.push('');
    }
    return lines.join('\n');
}

function parseYamlPage(yamlContent, baseDir) {
    let pageName = 'default';
    const components = [];
    let curComp = null;
    let curSection = null;
    let curMultilineKey = null;
    let curMultilineLines = [];
    let curMultilineIndent = 0;

    const lines = yamlContent.split('\n');

    function flushMultiline() {
        if (curComp && curSection && curMultilineKey) {
            if (!curComp[curSection]) curComp[curSection] = {};
            curComp[curSection][curMultilineKey] = curMultilineLines.join('\n');
        }
        curMultilineKey = null;
        curMultilineLines = [];
        curMultilineIndent = 0;
    }

    for (let rawLine of lines) {
        if (curMultilineKey) {
            const indentMatch = rawLine.match(/^(\s*)/);
            const indentLen = indentMatch ? indentMatch[1].length : 0;
            const trimmed = rawLine.trim();

            if (trimmed.length === 0) {
                curMultilineLines.push('');
                continue;
            }

            if (indentLen < curMultilineIndent && trimmed.length > 0) {
                flushMultiline();
            } else {
                curMultilineLines.push(rawLine.slice(curMultilineIndent));
                continue;
            }
        }

        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        if (trimmed.startsWith('page:')) {
            flushMultiline();
            curSection = null;
            const rawVal = trimmed.slice(trimmed.indexOf(':') + 1).trim();
            const pageMatch = rawVal.match(/^"([^"]*)"/) || rawVal.match(/^'([^']*)'/);
            pageName = pageMatch ? pageMatch[1] : rawVal.split('#')[0].trim();
            curComp = null;
            continue;
        }

        if (trimmed.startsWith('- objname:')) {
            flushMultiline();
            curSection = null;
            const rawVal = trimmed.slice(trimmed.indexOf(':') + 1).trim();
            const objMatch = rawVal.match(/^"([^"]*)"/) || rawVal.match(/^'([^']*)'/);
            const objname = objMatch ? objMatch[1] : rawVal.split('#')[0].trim();
            curComp = { objname };
            components.push(curComp);
            continue;
        }

        if (!curComp) continue;

        const indentMatch = rawLine.match(/^(\s*)/);
        const indentLen = indentMatch ? indentMatch[1].length : 0;

        if (trimmed === 'scripts:' || trimmed.startsWith('scripts:')) {
            flushMultiline();
            curSection = 'scripts';
            if (!curComp.scripts) curComp.scripts = {};
            continue;
        }

        if (curSection === 'scripts' && indentLen >= 4 && trimmed.includes(':')) {
            const colonIdx = trimmed.indexOf(':');
            const key = trimmed.slice(0, colonIdx).trim();
            let rawVal = trimmed.slice(colonIdx + 1).trim();

            if (rawVal === '|' || rawVal === '|-') {
                curMultilineKey = key;
                curMultilineIndent = indentLen + 2;
                curMultilineLines = [];
                continue;
            }

            let val = rawVal;
            if (rawVal.startsWith('"') && rawVal.lastIndexOf('"') > 0) {
                val = rawVal.slice(1, rawVal.lastIndexOf('"'));
            } else if (rawVal.startsWith("'") && rawVal.lastIndexOf("'") > 0) {
                val = rawVal.slice(1, rawVal.lastIndexOf("'"));
            } else {
                val = rawVal.split('#')[0].trim();
            }

            if (baseDir && typeof val === 'string' && val.length > 0 && !val.includes('\n')) {
                const candidates = [
                    path.resolve(baseDir, val),
                    path.resolve(baseDir, '..', val),
                    path.resolve(baseDir, 'scripts', val)
                ];
                for (const c of candidates) {
                    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
                        val = fs.readFileSync(c, 'utf8');
                        break;
                    }
                }
            }

            if (!curComp.scripts) curComp.scripts = {};
            curComp.scripts[key] = val;
            continue;
        }

        if (curSection && indentLen <= 4 && !trimmed.startsWith('scripts:')) {
            flushMultiline();
            curSection = null;
        }

        if (trimmed.includes(':')) {
            const colonIdx = trimmed.indexOf(':');
            const key = trimmed.slice(0, colonIdx).trim();
            let rawVal = trimmed.slice(colonIdx + 1).trim();
            if (rawVal.startsWith('"')) {
                const endQuote = rawVal.lastIndexOf('"');
                if (endQuote > 0) {
                    curComp[key] = rawVal.slice(1, endQuote).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                } else {
                    curComp[key] = rawVal.slice(1);
                }
            } else if (rawVal.startsWith("'")) {
                const endQuote = rawVal.lastIndexOf("'");
                if (endQuote > 0) {
                    curComp[key] = rawVal.slice(1, endQuote);
                } else {
                    curComp[key] = rawVal.slice(1);
                }
            } else {
                rawVal = rawVal.split('#')[0].trim();
                const val = parseInt(rawVal, 10);
                if (!isNaN(val) && String(val) === rawVal) {
                    curComp[key] = val;
                } else {
                    curComp[key] = rawVal;
                }
            }
        }
    }
    flushMultiline();
    return { name: pageName, components };
}

// ============================================================================
// EXPORT COMMAND
// ============================================================================

function exportHmi(hmiPath, outDir) {
    const absHmiPath = path.resolve(hmiPath);
    if (!fs.existsSync(absHmiPath)) {
        throw new Error(`Source HMI file not found: ${hmiPath}`);
    }

    const defaultDirName = path.basename(absHmiPath, path.extname(absHmiPath));
    const targetDir = path.resolve(outDir || defaultDirName);

    console.log(`[EXPORT] Reading HMI file: ${absHmiPath}...`);
    const hmiBuf = fs.readFileSync(absHmiPath);

    fs.mkdirSync(path.join(targetDir, 'pages'), { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'pictures'), { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'fonts'), { recursive: true });

    // Parse directory table
    const fileCount = hmiBuf.readUInt32LE(0);
    const archiveFiles = new Map();
    let pos = 4;
    let mainHmiBuf = null;
    for (let i = 0; i < fileCount; i++) {
        const rawName = hmiBuf.toString('latin1', pos, pos + 16);
        if (rawName.charCodeAt(0) !== 0) {
            const name = rawName.replace(/\0.*$/, '');
            const offset = hmiBuf.readUInt32LE(pos + 16);
            const size = hmiBuf.readUInt32LE(pos + 20);
            archiveFiles.set(name, { offset, size, data: hmiBuf.subarray(offset, offset + size) });
            if (name === 'main.HMI') mainHmiBuf = archiveFiles.get(name).data;
        }
        pos += 28;
    }

    if (!mainHmiBuf) throw new Error('main.HMI project header not found inside archive.');

    // 1. Export Pictures
    const pictureRecords = [];
    const picturesYamlList = [];
    let picSeqId = 0;
    for (let p = 0x60; p < mainHmiBuf.length; p += 16) {
        const type = mainHmiBuf.toString('latin1', p, p + 8).replace(/\0.*$/, '');
        const name = mainHmiBuf.toString('latin1', p + 8, p + 16).replace(/\0.*$/, '');
        if (type === 'i') {
            const isName = name.replace(/\.i$/, '.is');
            const fileEntry = archiveFiles.get(isName);
            let width = 0, height = 0, pngBuf = null;
            if (fileEntry) {
                const isData = fileEntry.data;
                width = isData.readUInt16LE(0x0c);
                height = isData.readUInt16LE(0x0e);
                pngBuf = isData.subarray(27);
            }

            const picFileName = `${picSeqId}.png`;
            let sha256 = '';
            if (pngBuf) {
                fs.writeFileSync(path.join(targetDir, 'pictures', picFileName), pngBuf);
                sha256 = crypto.createHash('sha256').update(pngBuf).digest('hex');
            }

            pictureRecords.push({
                id: picSeqId,
                name,
                isName,
                file: picFileName,
                width,
                height,
                sha256
            });

            picturesYamlList.push(`  - id: ${picSeqId}\n    name: "${name}"\n    file: "${picFileName}"\n    width: ${width}\n    height: ${height}`);
            picSeqId++;
        }
    }

    const picturesYamlContent = [
        '# Nextion HMI Pictures Definition',
        '# Picture IDs are strictly sequential (0, 1, 2, ...).',
        '# You can replace existing pictures or append new pictures at the end.',
        'pictures:',
        picturesYamlList.join('\n')
    ].join('\n') + '\n';

    fs.writeFileSync(path.join(targetDir, 'pictures.yaml'), picturesYamlContent, 'utf8');
    console.log(`[EXPORT] Extracted ${pictureRecords.length} picture assets to: ${path.join(targetDir, 'pictures')}`);

    // 1b. Export Fonts (.zi)
    const fontRecords = [];
    const fontsYamlList = [];
    let fontSeqId = 0;
    for (let p = 0x60; p < mainHmiBuf.length; p += 16) {
        const type = mainHmiBuf.toString('latin1', p, p + 8).replace(/\0.*$/, '');
        const name = mainHmiBuf.toString('latin1', p + 8, p + 16).replace(/\0.*$/, '');
        if (type === 'zi') {
            const fileEntry = archiveFiles.get(name);
            const fontFileName = `${fontSeqId}.zi`;
            let sha256 = '';
            if (fileEntry) {
                fs.writeFileSync(path.join(targetDir, 'fonts', fontFileName), fileEntry.data);
                sha256 = crypto.createHash('sha256').update(fileEntry.data).digest('hex');
            }
            fontRecords.push({
                id: fontSeqId,
                name,
                file: fontFileName,
                size: fileEntry ? fileEntry.size : 0,
                sha256
            });
            fontsYamlList.push(`  - id: ${fontSeqId}\n    name: "${name}"\n    file: "${fontFileName}"\n    size: ${fileEntry ? fileEntry.size : 0}`);
            fontSeqId++;
        }
    }

    const fontsYamlContent = [
        '# Nextion HMI Fonts Definition',
        '# Font IDs are strictly sequential (0, 1, 2, ...).',
        '# You can replace existing font .zi files or append new fonts at the end.',
        'fonts:',
        fontsYamlList.join('\n')
    ].join('\n') + '\n';

    fs.writeFileSync(path.join(targetDir, 'fonts.yaml'), fontsYamlContent, 'utf8');
    console.log(`[EXPORT] Extracted ${fontRecords.length} font assets to: ${path.join(targetDir, 'fonts')}`);

    // 2. Export Pages
    const pages = scanHmi(hmiBuf);
    const componentMap = {};
    for (const page of pages) {
        const scriptsDirRel = path.join('scripts', page.name).replace(/\\/g, '/');
        const scriptsDirAbs = path.join(targetDir, 'scripts', page.name);
        const pageYamlContent = pageToYaml(page, scriptsDirRel, scriptsDirAbs);
        const pageYamlPath = path.join(targetDir, 'pages', `${page.name}.yaml`);
        fs.writeFileSync(pageYamlPath, pageYamlContent, 'utf8');

        componentMap[page.name] = {};
        for (const comp of page.components) {
            componentMap[page.name][comp.objname] = {
                type: comp.type,
                offset: comp.offset,
                propOffsets: comp.propOffsets
            };
        }
    }
    console.log(`[EXPORT] Extracted ${pages.length} pages to: ${path.join(targetDir, 'pages')}`);

    // 3. Write project manifest JSON
    const relativeSourceHmi = path.relative(targetDir, absHmiPath).replace(/\\/g, '/');
    const manifest = {
        tool: 'nextion-hmi-tool',
        version: '1.0.0',
        sourceHmi: relativeSourceHmi,
        sourceHmiAbs: absHmiPath,
        sourceSha256: crypto.createHash('sha256').update(hmiBuf).digest('hex'),
        exportedAt: new Date().toISOString(),
        pictureCount: pictureRecords.length,
        originalPictures: pictureRecords,
        fontCount: fontRecords.length,
        originalFonts: fontRecords,
        pages: pages.map(p => p.name),
        componentMap
    };

    fs.writeFileSync(path.join(targetDir, 'project.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`[EXPORT] Project manifest written to: ${path.join(targetDir, 'project.json')}`);
    console.log(`[EXPORT] Successfully exported to directory: ${targetDir}`);
}

// ============================================================================
// IMPORT COMMAND
// ============================================================================

function parsePicturesYaml(content) {
    const pictures = [];
    let curPic = null;
    for (let line of content.split('\n')) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('- id:')) {
            const id = parseInt(line.split(':')[1].trim(), 10);
            curPic = { id };
            pictures.push(curPic);
            continue;
        }
        if (curPic && line.includes(':')) {
            const parts = line.split(':');
            const k = parts[0].trim();
            const v = parts.slice(1).join(':').replace(/["']/g, '').trim();
            const num = parseInt(v, 10);
            curPic[k] = (!isNaN(num) && String(num) === v) ? num : v;
        }
    }
    return pictures;
}

function parseFontsYaml(content) {
    const fonts = [];
    let curFont = null;
    for (let line of content.split('\n')) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('- id:')) {
            const id = parseInt(line.split(':')[1].trim(), 10);
            curFont = { id };
            fonts.push(curFont);
            continue;
        }
        if (curFont && line.includes(':')) {
            const parts = line.split(':');
            const k = parts[0].trim();
            const v = parts.slice(1).join(':').replace(/["']/g, '').trim();
            const num = parseInt(v, 10);
            curFont[k] = (!isNaN(num) && String(num) === v) ? num : v;
        }
    }
    return fonts;
}

// ============================================================================
// Pre-Import Project Validator
// Strictly enforces Nextion HMI hardware & editor specifications before
// modifying or creating any files.
// ============================================================================

function validateProjectBeforeImport(absProjDir) {
    const errors = [];

    // Read manifest for baseline integrity comparison
    let manifest = null;
    const manifestPath = path.join(absProjDir, 'project.json');
    if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {}
    }

    // 1. Validate pictures.yaml & protections
    const picturesYamlPath = path.join(absProjDir, 'pictures.yaml');
    if (fs.existsSync(picturesYamlPath)) {
        try {
            const picList = parsePicturesYaml(fs.readFileSync(picturesYamlPath, 'utf8'));
            const origPics = (manifest && manifest.originalPictures) || [];

            // A. Check strictly sequential IDs (0, 1, 2, ...)
            for (let i = 0; i < picList.length; i++) {
                const p = picList[i];
                if (p.id === undefined || typeof p.id !== 'number' || p.id !== i) {
                    errors.push(`Picture IDs in pictures.yaml must be strictly sequential (0, 1, 2, ...). Entry #${i} has ID ${p.id} (expected ${i}). Non-sequential IDs or removing picture entries will scramble component bindings and corrupt Nextion Editor tables.`);
                }
                const pngPath = path.join(absProjDir, 'pictures', p.file || `${p.id}.png`);
                if (!fs.existsSync(pngPath)) {
                    errors.push(`Picture file not found: "${p.file || p.id + '.png'}" for picture ID ${p.id}`);
                }
            }

            // B. Protection against removing pictures
            if (origPics.length > 0 && picList.length < origPics.length) {
                errors.push(`Removing pictures is unsupported. The project originally had ${origPics.length} pictures, but pictures.yaml contains ${picList.length}. Deleting pictures shifts picture IDs and breaks component bindings (pic/picc) across pages. To change a picture, replace its PNG file instead of deleting the entry.`);
            }

            // C. Protection against modifying picture order
            const checkPicCount = Math.min(picList.length, origPics.length);
            for (let i = 0; i < checkPicCount; i++) {
                if (origPics[i] && picList[i].name && picList[i].name !== origPics[i].name) {
                    errors.push(`Modifying picture order is unsupported. Picture ID ${i} was originally "${origPics[i].name}", but found "${picList[i].name}". Reordering pictures scrambles Nextion picture references. You may only replace existing PNG images or append new pictures at the end.`);
                }
            }
        } catch (e) {
            errors.push(`Failed to parse pictures.yaml: ${e.message}`);
        }
    }

    // 2. Validate fonts.yaml & protections
    const fontsYamlPath = path.join(absProjDir, 'fonts.yaml');
    if (fs.existsSync(fontsYamlPath)) {
        try {
            const fontList = parseFontsYaml(fs.readFileSync(fontsYamlPath, 'utf8'));
            const origFonts = (manifest && manifest.originalFonts) || [];

            // A. Check strictly sequential IDs
            for (let i = 0; i < fontList.length; i++) {
                const f = fontList[i];
                if (f.id === undefined || typeof f.id !== 'number' || f.id !== i) {
                    errors.push(`Font IDs in fonts.yaml must be strictly sequential (0, 1, 2, ...). Entry #${i} has ID ${f.id} (expected ${i}). Non-sequential IDs corrupt Nextion font bindings.`);
                }
                const ziPath = path.join(absProjDir, 'fonts', f.file || `${f.id}.zi`);
                if (!fs.existsSync(ziPath)) {
                    errors.push(`Font file not found: "${f.file || f.id + '.zi'}" for font ID ${f.id}`);
                }
            }

            // B. Protection against removing fonts
            if (origFonts.length > 0 && fontList.length < origFonts.length) {
                errors.push(`Removing fonts is unsupported. The project originally had ${origFonts.length} fonts, but fonts.yaml contains ${fontList.length}. Deleting fonts shifts font IDs and scrambles text component font bindings across pages. To change a font, replace its .zi file instead of deleting the entry.`);
            }

            // C. Protection against modifying font order
            const checkFontCount = Math.min(fontList.length, origFonts.length);
            for (let i = 0; i < checkFontCount; i++) {
                if (origFonts[i] && fontList[i].name && fontList[i].name !== origFonts[i].name) {
                    errors.push(`Modifying font order is unsupported. Font ID ${i} was originally "${origFonts[i].name}", but found "${fontList[i].name}". Reordering fonts scrambles Nextion font references.`);
                }
            }
        } catch (e) {
            errors.push(`Failed to parse fonts.yaml: ${e.message}`);
        }
    }

    // 2. Validate pages/*.yaml
    const pagesDir = path.join(absProjDir, 'pages');
    if (fs.existsSync(pagesDir)) {
        const pageFiles = fs.readdirSync(pagesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

        for (const pf of pageFiles) {
            const yamlPath = path.join(pagesDir, pf);
            let pageData = null;
            try {
                pageData = parseYamlPage(fs.readFileSync(yamlPath, 'utf8'));
            } catch (e) {
                errors.push(`Failed to parse YAML page "${pf}": ${e.message}`);
                continue;
            }

            const pageName = pageData.name || path.basename(pf, path.extname(pf));
            if (Buffer.byteLength(pageName, 'utf8') > 14) {
                errors.push(`Page name "${pageName}" in ${pf} exceeds Nextion max length of 14 bytes (${Buffer.byteLength(pageName, 'utf8')} bytes).`);
            }

            const compNames = new Set();
            for (let i = 0; i < pageData.components.length; i++) {
                const c = pageData.components[i];
                if (!c.objname) {
                    errors.push(`Component #${i} in page "${pageName}" is missing an objname.`);
                    continue;
                }

                const byteLen = Buffer.byteLength(c.objname, 'utf8');
                if (byteLen < 1 || byteLen > 14) {
                    errors.push(`Component "${c.objname}" on page "${pageName}" has invalid length (${byteLen} bytes). Nextion requires: Min Length 1 byte, Max Length 14 bytes.`);
                }

                if (!/^[a-zA-Z0-9_]+$/.test(c.objname)) {
                    errors.push(`Component "${c.objname}" on page "${pageName}" contains invalid characters. Nextion names only allow letters, numbers, and underscores.`);
                }

                if (compNames.has(c.objname)) {
                    errors.push(`Duplicate component objname "${c.objname}" found on page "${pageName}". Each component on a page must have a unique name.`);
                }
                compNames.add(c.objname);

                const isNonVisual = c.type === 'variable' || c.type === 'timer';
                if (!isNonVisual) {
                    if (typeof c.x === 'number' && c.x < 0) {
                        errors.push(`Component "${c.objname}" on page "${pageName}" has invalid negative x coordinate (${c.x}).`);
                    }
                    if (typeof c.y === 'number' && c.y < 0) {
                        errors.push(`Component "${c.objname}" on page "${pageName}" has invalid negative y coordinate (${c.y}).`);
                    }
                    if (typeof c.w === 'number' && c.w <= 0) {
                        errors.push(`Component "${c.objname}" on page "${pageName}" has invalid non-positive width (${c.w}).`);
                    }
                    if (typeof c.h === 'number' && c.h <= 0) {
                        errors.push(`Component "${c.objname}" on page "${pageName}" has invalid non-positive height (${c.h}).`);
                    }
                }
            }

            // Protection against removing components
            if (manifest && manifest.componentMap && manifest.componentMap[pageName]) {
                const origComps = Object.keys(manifest.componentMap[pageName]);
                const missingComps = [];
                for (const origComp of origComps) {
                    if (!compNames.has(origComp)) {
                        missingComps.push(origComp);
                    }
                }
                if (missingComps.length > 0) {
                    errors.push(`Removing page components is unsupported. Page "${pageName}" in ${pf} is missing ${missingComps.length} original component(s): ${missingComps.map(c => `"${c}"`).join(', ')}. Deleting components from YAML shifts Nextion component IDs and may break internal script references. You can modify properties or add new components, but all original components must be preserved.`);
                }
            }
        }
    }

    if (errors.length > 0) {
        console.error('\n' + '='.repeat(75));
        console.error(' [VALIDATION FAILED] Nextion Specifications Violation:');
        console.error(' Cannot build HMI because the project definition contains errors:');
        for (const err of errors) {
            console.error(`   * ${err}`);
        }
        console.error('='.repeat(75) + '\n');
        throw new Error(`Project validation failed with ${errors.length} error(s). Aborted HMI generation to prevent creating an invalid or corrupted file.`);
    }
}

function importHmi(projectDir, outHmiPath) {
    const absProjDir = path.resolve(projectDir);

    // Validate project before touching any files or buffers
    validateProjectBeforeImport(absProjDir);
    const manifestPath = path.join(absProjDir, 'project.json');

    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Project manifest not found: ${manifestPath}\nPlease specify a valid exported project folder.`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // Resolve source HMI
    let srcHmi = path.resolve(absProjDir, manifest.sourceHmi);
    if (!fs.existsSync(srcHmi) && manifest.sourceHmiAbs && fs.existsSync(manifest.sourceHmiAbs)) {
        srcHmi = manifest.sourceHmiAbs;
    }
    if (!fs.existsSync(srcHmi)) {
        throw new Error(`Source HMI file not found at: ${srcHmi}`);
    }

    // Determine target output path (NEVER overwrite source HMI)
    let targetOutHmi = null;
    if (outHmiPath) {
        targetOutHmi = path.resolve(outHmiPath);
    } else {
        const dir = path.dirname(srcHmi);
        const base = path.basename(srcHmi, path.extname(srcHmi));
        targetOutHmi = path.join(dir, `${base}_modified.HMI`);
    }

    if (targetOutHmi.toLowerCase() === srcHmi.toLowerCase()) {
        throw new Error(`Safety Error: Output HMI path cannot overwrite source HMI: ${srcHmi}`);
    }

    console.log(`[IMPORT] Loading base HMI: ${srcHmi}...`);
    let hmiBuf = Buffer.from(fs.readFileSync(srcHmi));

    // 1. Process Pictures (pictures.yaml)
    const picturesYamlPath = path.join(absProjDir, 'pictures.yaml');

    if (fs.existsSync(picturesYamlPath)) {
        const picList = parsePicturesYaml(fs.readFileSync(picturesYamlPath, 'utf8'));
        const origPics = manifest.originalPictures || [];
        const replacements = [];

        for (const p of picList) {
            const pngPath = path.join(absProjDir, 'pictures', p.file || `${p.id}.png`);
            if (!fs.existsSync(pngPath)) {
                console.warn(`[WARN] Picture file not found: ${pngPath}`);
                continue;
            }
            const pngBuf = fs.readFileSync(pngPath);
            const currentSha = crypto.createHash('sha256').update(pngBuf).digest('hex');

            const origPic = origPics.find(op => op.id === p.id);
            if (!origPic) {
                // NEW picture added!
                console.log(`[IMPORT] Detected new picture ID ${p.id} (${pngPath}). Adding to HMI...`);
                const added = addImageToHmi(hmiBuf, p.id, pngBuf);
                hmiBuf = added.outBuf;
            } else if (origPic.sha256 !== currentSha) {
                // MODIFIED existing picture!
                console.log(`[IMPORT] Detected modified picture ID ${p.id} (${pngPath}). Replacing in HMI...`);
                replacements.push({ origPic, pngBuf });
            }
        }
        if (replacements.length > 0) {
            hmiBuf = replaceImagesInHmi(hmiBuf, replacements);
            console.log(`[IMPORT] Successfully replaced ${replacements.length} existing picture(s) in HMI archive.`);
        }
    }

    // 1b. Process Fonts (fonts.yaml)
    const fontsYamlPath = path.join(absProjDir, 'fonts.yaml');
    if (fs.existsSync(fontsYamlPath)) {
        const fontList = parseFontsYaml(fs.readFileSync(fontsYamlPath, 'utf8'));
        const origFonts = manifest.originalFonts || [];

        for (const f of fontList) {
            const ziPath = path.join(absProjDir, 'fonts', f.file || `${f.id}.zi`);
            if (!fs.existsSync(ziPath)) {
                console.warn(`[WARN] Font file not found: ${ziPath}`);
                continue;
            }
            const ziBuf = fs.readFileSync(ziPath);
            const currentSha = crypto.createHash('sha256').update(ziBuf).digest('hex');

            const origFont = origFonts.find(of => of.id === f.id);
            if (!origFont) {
                // NEW font added!
                console.log(`[IMPORT] Detected new font ID ${f.id} (${ziPath}). Adding to HMI...`);
                hmiBuf = addOrUpdateFontInHmi(hmiBuf, f.id, ziBuf, f.name);
            } else if (origFont.sha256 !== currentSha) {
                // MODIFIED existing font!
                console.log(`[IMPORT] Detected modified font ID ${f.id} (${ziPath}). Updating in HMI...`);
                hmiBuf = addOrUpdateFontInHmi(hmiBuf, f.id, ziBuf, f.name);
            }
        }
    }

    // 2. Process Pages (pages/*.yaml)
    const pagesDir = path.join(absProjDir, 'pages');
    if (fs.existsSync(pagesDir)) {
        const pageFiles = fs.readdirSync(pagesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

        for (const pf of pageFiles) {
            const yamlContent = fs.readFileSync(path.join(pagesDir, pf), 'utf8');
            const pageData = parseYamlPage(yamlContent, pagesDir);
            hmiBuf = patchPage(hmiBuf, pageData);
        }
    }

    // 3. Recalculate all page CRCs and sync archive directory tables
    recalculateAllPageCrcs(hmiBuf);

    // 4. Write new HMI file
    fs.writeFileSync(targetOutHmi, hmiBuf);
    console.log(`[IMPORT] Successfully created new HMI: ${targetOutHmi} (${hmiBuf.length} bytes)`);
    console.log('[IMPORT] Done! You can now open this file in Nextion Editor or compile it.');
}

// ============================================================================
// Helper: Append Image to HMI Archive (Preserving Sequential Order)
// ============================================================================


function replaceArchiveFile(hmiBuf, targetName, newBuf) {
    const entryCount = hmiBuf.readUInt32LE(0);
    let targetEntry = null;
    for (let i = 0; i < entryCount; i++) {
        const pos = 4 + i * 28;
        const name = hmiBuf.toString('latin1', pos, pos + 16).replace(/\0.*$/, '');
        if (name === targetName) {
            const start = hmiBuf.readUInt32LE(pos + 16);
            const size = hmiBuf.readUInt32LE(pos + 20);
            targetEntry = { index: i, pos, name, start, size };
            break;
        }
    }
    if (!targetEntry) {
        console.warn(`[WARN] File "${targetName}" not found in HMI archive.`);
        return hmiBuf;
    }

    const delta = newBuf.length - targetEntry.size;
    let newHmi = hmiBuf;
    if (delta !== 0) {
        newHmi = Buffer.alloc(hmiBuf.length + delta);
        hmiBuf.copy(newHmi, 0, 0, targetEntry.start);
        newBuf.copy(newHmi, targetEntry.start);
        hmiBuf.copy(newHmi, targetEntry.start + newBuf.length, targetEntry.start + targetEntry.size);

        for (let i = 0; i < entryCount; i++) {
            const pos = 4 + i * 28;
            const start = newHmi.readUInt32LE(pos + 16);
            if (pos === targetEntry.pos) {
                newHmi.writeUInt32LE(newBuf.length, pos + 20);
            } else if (start > targetEntry.start) {
                newHmi.writeUInt32LE(start + delta, pos + 16);
            }
        }
    } else {
        newBuf.copy(newHmi, targetEntry.start);
    }

    syncArchiveDirectoryTables(newHmi);
    return newHmi;
}

function replaceImagesInHmi(srcHmiBuf, replacements) {
    let currentHmi = srcHmiBuf;
    for (const { origPic, pngBuf } of replacements) {
        const decoded = decodePngToRgb565(pngBuf);
        const isBuf = buildIsBuffer(pngBuf, decoded.width, decoded.height);
        const iBuf = buildIBuffer(decoded.rgb565Buf, decoded.width, decoded.height);

        const targetIName = origPic.name || (origPic.id + '.i');
        const targetIsName = origPic.isName || targetIName.replace(/\.i$/, '.is');

        currentHmi = replaceArchiveFile(currentHmi, targetIName, iBuf);
        currentHmi = replaceArchiveFile(currentHmi, targetIsName, isBuf);
    }
    return currentHmi;
}

function addImageToHmi(srcHmiBuf, imageId, pngBuf) {
    const decoded = decodePngToRgb565(pngBuf);
    const isBuf = buildIsBuffer(pngBuf, decoded.width, decoded.height);
    const iBuf = buildIBuffer(decoded.rgb565Buf, decoded.width, decoded.height);

    const fileCount = srcHmiBuf.readUInt32LE(0);
    const archiveFiles = new Map();
    let pos = 4;
    for (let i = 0; i < fileCount; i++) {
        const rawName = srcHmiBuf.toString('latin1', pos, pos + 16);
        if (rawName.charCodeAt(0) !== 0) {
            const name = rawName.replace(/\0.*$/, '');
            const offset = srcHmiBuf.readUInt32LE(pos + 16);
            const size = srcHmiBuf.readUInt32LE(pos + 20);
            const f24 = srcHmiBuf.readUInt32LE(pos + 24);
            archiveFiles.set(name, {
                name,
                f24,
                data: Buffer.from(srcHmiBuf.subarray(offset, offset + size))
            });
        }
        pos += 28;
    }

    const mainHmiEntry = archiveFiles.get('main.HMI');
    if (!mainHmiEntry) throw new Error('main.HMI not found in archive');

    const oldMainHmi = mainHmiEntry.data;
    const records = [];
    for (let p = 0x60; p < oldMainHmi.length; p += 16) {
        const type = oldMainHmi.toString('latin1', p, p + 8).replace(/\0.*$/, '');
        const name = oldMainHmi.toString('latin1', p + 8, p + 16).replace(/\0.*$/, '');
        records.push({ type, name });
    }

    let lastImageIdx = -1;
    let maxFileNum = -1;
    for (let i = 0; i < records.length; i++) {
        if (records[i].type === 'i') {
            lastImageIdx = i;
            const num = parseInt(records[i].name);
            if (!isNaN(num) && num > maxFileNum) maxFileNum = num;
        }
    }

    const assignedPictureId = lastImageIdx + 1;
    let nextNum = Math.max(maxFileNum + 1, assignedPictureId);
    while (archiveFiles.has(nextNum + ".i") || archiveFiles.has(nextNum + ".is")) {
        nextNum++;
    }
    const fileId = nextNum;
    const targetName = fileId + ".i";

    const insertPos = lastImageIdx + 1;
    records.splice(insertPos, 0, { type: 'i', name: targetName });

    const newMainHmi = Buffer.alloc(0x60 + records.length * 16);
    oldMainHmi.copy(newMainHmi, 0, 0, 0x60);
    newMainHmi.writeUInt32LE(records.length, 0x1c);
    for (let i = 0; i < records.length; i++) {
        const recOff = 0x60 + i * 16;
        newMainHmi.write(records[i].type, recOff, 8, 'latin1');
        newMainHmi.write(records[i].name, recOff + 8, 8, 'latin1');
    }

    const mainCrc = computeNextionMainHmiCrc(newMainHmi);
    newMainHmi.writeUInt32LE(mainCrc, 0);

    archiveFiles.set('main.HMI', { name: 'main.HMI', f24: 0, data: newMainHmi });
    archiveFiles.set(`${fileId}.is`, { name: `${fileId}.is`, f24: 0, data: isBuf });
    archiveFiles.set(`${fileId}.i`, { name: `${fileId}.i`, f24: 0, data: iBuf });

    const fileList = Array.from(archiveFiles.values());
    const newCount = fileList.length;
    const tableLen = 4 + newCount * 28;

    let currentOffset = 0x700000;
    for (const f of fileList) {
        f.offset = currentOffset;
        f.size = f.data.length;
        currentOffset += f.size;
    }

    const outBuf = Buffer.alloc(currentOffset);
    outBuf.writeUInt32LE(newCount, 0);

    let dirPos = 4;
    for (const f of fileList) {
        outBuf.write(f.name, dirPos, 16, 'latin1');
        outBuf.writeUInt32LE(f.offset, dirPos + 16);
        outBuf.writeUInt32LE(f.size, dirPos + 20);
        outBuf.writeUInt32LE(f.f24 || 0, dirPos + 24);
        f.data.copy(outBuf, f.offset);
        dirPos += 28;
    }

    const tableCrc = computeTableCrc(outBuf.subarray(0, tableLen));
    outBuf.writeUInt32LE(tableCrc, tableLen);
    outBuf.copy(outBuf, 0x80000, 0, tableLen + 4);

    return { outBuf, imageId: assignedPictureId, fileId, width: decoded.width, height: decoded.height };
}


function addOrUpdateFontInHmi(srcHmiBuf, fontId, ziBuf, fontName) {
    const fileCount = srcHmiBuf.readUInt32LE(0);
    const archiveFiles = new Map();
    let pos = 4;
    for (let i = 0; i < fileCount; i++) {
        const rawName = srcHmiBuf.toString('latin1', pos, pos + 16);
        if (rawName.charCodeAt(0) !== 0) {
            const name = rawName.replace(/\0.*$/, '');
            const offset = srcHmiBuf.readUInt32LE(pos + 16);
            const size = srcHmiBuf.readUInt32LE(pos + 20);
            const f24 = srcHmiBuf.readUInt32LE(pos + 24);
            archiveFiles.set(name, {
                name,
                f24,
                data: Buffer.from(srcHmiBuf.subarray(offset, offset + size))
            });
        }
        pos += 28;
    }

    const mainHmiEntry = archiveFiles.get('main.HMI');
    if (!mainHmiEntry) throw new Error('main.HMI not found in archive');

    const oldMainHmi = mainHmiEntry.data;
    const records = [];
    for (let p = 0x60; p < oldMainHmi.length; p += 16) {
        const type = oldMainHmi.toString('latin1', p, p + 8).replace(/\0.*$/, '');
        const name = oldMainHmi.toString('latin1', p + 8, p + 16).replace(/\0.*$/, '');
        records.push({ type, name });
    }

    let existingIdx = -1;
    let ziCount = 0;
    let lastZiIdx = -1;
    let maxFileNum = -1;
    for (let i = 0; i < records.length; i++) {
        if (records[i].type === 'zi') {
            if (ziCount === fontId) existingIdx = i;
            lastZiIdx = i;
            ziCount++;
            const num = parseInt(records[i].name);
            if (!isNaN(num) && num > maxFileNum) maxFileNum = num;
        }
    }

    if (existingIdx !== -1) {
        const recName = records[existingIdx].name;
        archiveFiles.set(recName, { name: recName, f24: 0, data: ziBuf });
    } else {
        let nextNum = Math.max(maxFileNum + 1, fontId);
        while (archiveFiles.has(nextNum + ".zi")) {
            nextNum++;
        }
        const newFileName = nextNum + ".zi";
        archiveFiles.set(newFileName, { name: newFileName, f24: 0, data: ziBuf });

        const insertPos = lastZiIdx + 1;
        records.splice(insertPos, 0, { type: 'zi', name: newFileName });

        const newMainHmi = Buffer.alloc(0x60 + records.length * 16);
        oldMainHmi.copy(newMainHmi, 0, 0, 0x60);
        newMainHmi.writeUInt32LE(records.length, 0x1c);
        for (let i = 0; i < records.length; i++) {
            const recOff = 0x60 + i * 16;
            newMainHmi.write(records[i].type, recOff, 8, 'latin1');
            newMainHmi.write(records[i].name, recOff + 8, 8, 'latin1');
        }

        const mainCrc = computeNextionMainHmiCrc(newMainHmi);
        newMainHmi.writeUInt32LE(mainCrc, 0);
        archiveFiles.set('main.HMI', { name: 'main.HMI', f24: 0, data: newMainHmi });
    }

    const fileList = Array.from(archiveFiles.values());
    const newCount = fileList.length;
    const tableLen = 4 + newCount * 28;

    let currentOffset = 0x700000;
    for (const f of fileList) {
        f.offset = currentOffset;
        f.size = f.data.length;
        currentOffset += f.size;
    }

    const outBuf = Buffer.alloc(currentOffset);
    outBuf.writeUInt32LE(newCount, 0);

    let dirPos = 4;
    for (const f of fileList) {
        outBuf.write(f.name, dirPos, 16, 'latin1');
        outBuf.writeUInt32LE(f.offset, dirPos + 16);
        outBuf.writeUInt32LE(f.size, dirPos + 20);
        outBuf.writeUInt32LE(f.f24 || 0, dirPos + 24);
        f.data.copy(outBuf, f.offset);
        dirPos += 28;
    }

    const tableCrc = computeTableCrc(outBuf.subarray(0, tableLen));
    outBuf.writeUInt32LE(tableCrc, tableLen);
    outBuf.copy(outBuf, 0x80000, 0, tableLen + 4);

    return outBuf;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (command === 'export') {
        const hmiPath = args[1];
        const outDir = args[2];
        if (!hmiPath) {
            console.error('Usage: node hmi_tool.js export <project.HMI> [output_directory]');
            process.exit(1);
        }
        exportHmi(hmiPath, outDir);
    } else if (command === 'import') {
        const projDir = args[1];
        const outHmi = args[2];
        if (!projDir) {
            console.error('Usage: node hmi_tool.js import <project_directory> [output.HMI]');
            process.exit(1);
        }
        importHmi(projDir, outHmi);
    } else {
        console.log(`
Nextion HMI Visual Layout & Asset Manager (nextion-hmi-tool)

Usage:
  node hmi_tool.js export <project.HMI> [output_directory]
    Extracts all pages into individual YAML files, all pictures into PNGs,
    and creates pictures.yaml & project.json manifest.
    (Default output directory: folder named after the HMI file)

  node hmi_tool.js import <project_directory> [output.HMI]
    Compiles modified page YAMLs and pictures back into a new HMI file.
    Always creates a new file; never overwrites the original source HMI.
        `);
    }
}

module.exports = {
    exportHmi,
    importHmi,
    addImageToHmi,
    addOrUpdateFontInHmi,
    computeNextionMainHmiCrc,
    computeTableCrc,
    computeNextionPageCrc
};

if (require.main === module) {
    main();
}
