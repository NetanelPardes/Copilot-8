const workbookEncoder = new TextEncoder();
const zipCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return crc >>> 0;
});

function zipCrc(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ zipCrcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
}

// An XLSX is a ZIP archive with a workbook, worksheet and their relationships.
function zipWorkbook(files) {
    const blocks = [];
    const directory = [];
    let offset = 0;
    let directorySize = 0;

    for (const [path, content] of files) {
        const name = workbookEncoder.encode(path);
        const data = workbookEncoder.encode(content);
        const crc = zipCrc(data);
        const local = new DataView(new ArrayBuffer(30));
        const central = new DataView(new ArrayBuffer(46));

        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(12, 33, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);

        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true);
        central.setUint16(6, 20, true);
        central.setUint16(14, 33, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, data.length, true);
        central.setUint32(24, data.length, true);
        central.setUint16(28, name.length, true);
        central.setUint32(42, offset, true);

        blocks.push(local.buffer, name, data);
        directory.push(central.buffer, name);
        offset += local.byteLength + name.length + data.length;
        directorySize += central.byteLength + name.length;
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);

    return new Blob([...blocks, ...directory, end.buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
}

function localParts(date) {
    const pad = (value, count = 2) => String(value).padStart(count, '0');
    return {
        date: [pad(date.getDate()), pad(date.getMonth() + 1), date.getFullYear()].join('-'),
        time: [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(':'),
        milliseconds: pad(date.getMilliseconds(), 3)
    };
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '\ufffd')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function worksheetRow(index, values, bold = false) {
    const cells = values.map((value, column) => {
        const ref = String.fromCharCode(65 + column) + index;
        const style = bold ? ' s="1"' : '';
        if (Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    });
    return `<row r="${index}">${cells.join('')}</row>`;
}

function buildRecordingWorkbook(events, started, ended, partial) {
    const start = localParts(started);
    const finish = localParts(ended);
    const headings = ['מספר אירוע', 'תאריך האירוע (מקומי)', 'שעת האירוע (מקומית)',
        'כיוון UART', 'Label באוקטלי', 'מזהה שידור מחזורי', 'מספר בתים',
        'מילה / בתים שנדחו בהקס', 'פרטי שגיאה', 'מזהה חבילת UART',
        'מספר מילים בחבילה', 'Checksum בהקס', 'חבילת UART מלאה בהקס'];
    const direction = { TX: 'שידור (TX)', RX: 'קליטה (RX)', ERROR: 'שגיאה' };
    const rows = [
        worksheetRow(1, ['תחילת הקלטה', start.date + ' ' + start.time]),
        worksheetRow(2, ['סיום הקלטה', finish.date + ' ' + finish.time]),
        worksheetRow(3, ['שלמות ההקלטה', partial ? 'חלקית · אירועים עשויים להיות חסרים' : 'לא זוהתה השמטת אירועים']),
        worksheetRow(4, headings, true)
    ];

    events.forEach((event, index) => {
        const local = localParts(new Date(event.time));
        const hex = event.hex ?? '';
        rows.push(worksheetRow(index + 5, [
            event.sequence, local.date, local.time + '.' + local.milliseconds,
            direction[event.direction] ?? event.direction,
            event.label ?? '', event.cycleId ?? '', hex ? hex.split(' ').length : 0,
            hex, event.error ?? '', event.packetId ?? '', event.wordCount ?? '',
            event.checksum ?? '', event.packetHex ?? ''
        ]));
    });

    const columns = [14, 24, 24, 17, 19, 40, 13, 66, 44, 40, 18, 16, 100].map((width, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('');

    return zipWorkbook([
        ['[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Default Extension="xml" ContentType="application/xml"/>
          <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
          <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
          <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
        </Types>`],
        ['_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
        </Relationships>`],
        ['xl/workbook.xml', `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <bookViews><workbookView/></bookViews><sheets><sheet name="תעבורת UART" sheetId="1" r:id="rId1"/></sheets>
        </workbook>`],
        ['xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        </Relationships>`],
        ['xl/styles.xml', `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
          <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
          <borders count="1"><border/></borders>
          <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
          <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
          <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
        </styleSheet>`],
        ['xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
          <cols>${columns}</cols><sheetData>${rows.join('')}</sheetData><autoFilter ref="A4:M${rows.length}"/>
        </worksheet>`]
    ]);
}

function recordingFilename(started, ended) {
    const start = localParts(started);
    const finish = localParts(ended);
    const endDate = start.date === finish.date ? '' : finish.date + ' ';
    return `${start.date} - ${start.time.replaceAll(':', '-')} - ${endDate}${finish.time.replaceAll(':', '-')}.xlsx`;
}

function downloadRecordingWorkbook(events, started, ended, partial) {
    const url = URL.createObjectURL(buildRecordingWorkbook(events, started, ended, partial));
    const link = document.createElement('a');
    link.href = url;
    link.download = recordingFilename(started, ended);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
