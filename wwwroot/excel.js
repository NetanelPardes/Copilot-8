const excelEncoder = new TextEncoder();

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return crc >>> 0;
});

function excelCrc(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
}

function excelDateParts(date) {
    const pad = (value, length = 2) => String(value).padStart(length, '0');

    return {
        date: [pad(date.getDate()), pad(date.getMonth() + 1), date.getFullYear()].join('-'),
        time: [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(':'),
        milliseconds: pad(date.getMilliseconds(), 3)
    };
}

function excelXml(value) {
    return String(value ?? '')
        .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '\ufffd')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function excelRow(index, values) {
    const cells = values.map((value, column) => {
        const ref = String.fromCharCode(65 + column) + index;

        if (Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
        }

        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${excelXml(value)}</t></is></c>`;
    });

    return `<row r="${index}">${cells.join('')}</row>`;
}

function excelZip(files) {
    const parts = [];
    const directory = [];
    let offset = 0;
    let directorySize = 0;

    for (const [path, xml] of files) {
        const name = excelEncoder.encode(path);
        const bytes = excelEncoder.encode(xml);
        const crc = excelCrc(bytes);
        const local = new DataView(new ArrayBuffer(30));
        const central = new DataView(new ArrayBuffer(46));

        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(12, 33, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, bytes.length, true);
        local.setUint32(22, bytes.length, true);
        local.setUint16(26, name.length, true);

        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true);
        central.setUint16(6, 20, true);
        central.setUint16(14, 33, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, bytes.length, true);
        central.setUint32(24, bytes.length, true);
        central.setUint16(28, name.length, true);
        central.setUint32(42, offset, true);

        parts.push(local.buffer, name, bytes);
        directory.push(central.buffer, name);

        offset += local.byteLength + name.length + bytes.length;
        directorySize += central.byteLength + name.length;
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...directory, end.buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
}

function buildRecordingWorkbook(events, started, ended, partial) {
    const start = excelDateParts(started);
    const finish = excelDateParts(ended);

    const directions = {
        TX: 'שידור (TX)',
        RX: 'קליטה (RX)',
        ERROR: 'שגיאה'
    };

    const rows = [
        excelRow(1, ['תחילת הקלטה', `${start.date} ${start.time}`]),
        excelRow(2, ['סיום הקלטה', `${finish.date} ${finish.time}`]),
        excelRow(3, [
            'שלמות ההקלטה',
            partial ? 'הקלטה חלקית. ייתכן שחסרים אירועים.' : 'לא זוהתה השמטת אירועים.'
        ]),
        excelRow(4, [
            'מספר אירוע', 'תאריך האירוע (מקומי)', 'שעת האירוע (מקומית)',
            'כיוון UART', 'Label באוקטלי', 'מזהה שידור מחזורי',
            'מספר בתים', 'בתים בהקסדצימלי', 'פרטי שגיאה'
        ])
    ];

    events.forEach((event, index) => {
        const local = excelDateParts(new Date(event.time));
        const hex = event.hex?.trim() ?? '';

        rows.push(excelRow(index + 5, [
            event.sequence,
            local.date,
            `${local.time}.${local.milliseconds}`,
            directions[event.direction] ?? event.direction,
            event.label ?? '',
            event.cycleId ?? '',
            hex ? hex.split(/\s+/).length : 0,
            hex,
            event.error ?? ''
        ]));
    });

    const columns = [14, 24, 24, 18, 19, 40, 13, 66, 44].map((width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
    ).join('');

    const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const officeNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

    return excelZip([
        ['[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>
            <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
            <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        </Types>`],
        ['_rels/.rels', `<Relationships xmlns="${packageNs}">
            <Relationship Id="rId1" Type="${officeNs}/officeDocument" Target="xl/workbook.xml"/>
        </Relationships>`],
        ['xl/workbook.xml', `<workbook xmlns="${sheetNs}" xmlns:r="${officeNs}">
            <bookViews><workbookView/></bookViews>
            <sheets><sheet name="תעבורת UART" sheetId="1" r:id="rId1"/></sheets>
        </workbook>`],
        ['xl/_rels/workbook.xml.rels', `<Relationships xmlns="${packageNs}">
            <Relationship Id="rId1" Type="${officeNs}/worksheet" Target="worksheets/sheet1.xml"/>
        </Relationships>`],
        ['xl/worksheets/sheet1.xml', `<worksheet xmlns="${sheetNs}">
            <sheetViews><sheetView workbookViewId="0" rightToLeft="1">
                <pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/>
            </sheetView></sheetViews>
            <cols>${columns}</cols>
            <sheetData>${rows.join('')}</sheetData>
            <autoFilter ref="A4:I${rows.length}"/>
        </worksheet>`]
    ]);
}

function downloadRecordingWorkbook(events, started, ended, partial) {
    const start = excelDateParts(started);
    const finish = excelDateParts(ended);
    const endDate = start.date === finish.date ? '' : finish.date + ' ';
    const startTime = start.time.replaceAll(':', '-');
    const endTime = finish.time.replaceAll(':', '-');

    const file = buildRecordingWorkbook(events, started, ended, partial);
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');

    link.href = url;
    link.download = `${start.date} - ${startTime} - ${endDate}${endTime}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}