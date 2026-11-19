function wordCoding(label) {
    if (label?.coding) return label.coding;
    if (label?.numericBnr) return 'BNR';
    if (!label) return 'UNKNOWN';
    const typed = label.section === '3.1' && label.equipment?.length === 1
        && ((decimalProfiles[label.code] && decimalEquipment[label.code]?.includes(label.equipment[0]))
            || (label.code === '032' && ['02', '12'].includes(label.equipment[0])));
    if (!typed && !hasStandardEnvelope(label.fields ?? [])) return 'UNKNOWN';
    if (/\bBNR\b/i.test(label.name ?? '')) return 'BNR';
    if (/\bBCD\b/i.test(label?.name ?? '')) return 'BCD';
    if (/\bDSC\b|DISCRETE/i.test(label?.name ?? '')) return 'DSC';
    return 'UNKNOWN';
}

function statusDescriptions(coding) {
    if (coding === 'BNR') return ['אזהרת תקלה', 'נתון לא זמין', 'בדיקה תפקודית', 'פעולה תקינה'];
    if (coding === 'BCD') return ['חיובי / צפון / מזרח', 'נתון לא זמין', 'בדיקה תפקודית', 'שלילי / דרום / מערב'];
    if (coding === 'DSC') return ['פעולה תקינה', 'נתון לא זמין', 'בדיקה תפקודית', 'אזהרת תקלה'];
    return ['משמעות לפי מפרט ההודעה', 'משמעות לפי מפרט ההודעה', 'משמעות לפי מפרט ההודעה', 'משמעות לפי מפרט ההודעה'];
}

function updateStatusOptions(label, preferred) {
    const coding = wordCoding(label);
    $('ssm').replaceChildren(...statusDescriptions(coding).map((description, value) =>
        new Option(value.toString(2).padStart(2, '0') + ' — ' + description, String(value))));
    $('ssm').value = String(preferred ?? (coding === 'BNR' ? 3 : 0));
}

function timingDescription(label, hertz) {
    const source = label?.arinc;
    if (!source || !hertz || !Number.isFinite(hertz)) return { text: '', warning: false };
    const interval = 1000 / hertz;
    const warning = interval < source.minTransmitMs - .001 || interval > source.maxTransmitMs + .001;
    return {
        text: `לפי המסמך: ${source.minTransmitMs}–${source.maxTransmitMs} מילישניות בין מילים `
            + `(${(1000 / source.maxTransmitMs).toFixed(3)}–${(1000 / source.minTransmitMs).toFixed(3)} Hz). `
            + (warning ? 'התדר שבחרת חורג מהטווח; מותר לצורך ניסוי.' : 'התדר שבחרת בטווח.'),
        warning
    };
}

function refreshArincInfo() {
    const label = labels.find(item => labelKey(item) === $('label').value);
    const source = label?.arinc;
    $('profile-info').textContent = source
        ? `ARINC 429 Part 1-17 · נספח ${source.attachment}, טבלה ${source.table} · עמוד מודפס ${source.printedPage} `
            + `(PDF ${source.pdfPage}) · ציוד ${source.equipmentHex} בהקס · ${source.significantBits} ביטים משמעותיים `
            + `· רזולוציה ${label.numericBnr.step} ${label.unit}. הטווח בעורך הוא טווח הקידוד שנבחר לפרופיל.`
        : 'הגדרה מהקטלוג הקיים. אין כאן סימון של אימות מחדש מול מסמך ARINC שהועלה.';
    const timing = $('mode').value === 'cycle' ? timingDescription(label, $('hz').valueAsNumber) : { text: '', warning: false };
    $('timing-info').textContent = timing.text;
    $('timing-info').className = timing.warning ? 'notice' : '';
    $('apply-timing').hidden = !source || $('mode').value !== 'cycle';
}

function decodeNumericField(field, data, sdi) {
    const combined = ((data << 2) | sdi) >>> 0;
    const raw = (combined >>> (field.first - 9)) & ((2 ** field.width) - 1);
    const readBcd = encoded => {
        let number = 0, multiplier = 1;
        while (encoded) {
            const digit = encoded & 15;
            if (digit > 9) throw new Error('ספרת BCD אינה תקינה');
            number += digit * multiplier;
            multiplier *= 10;
            encoded >>>= 4;
        }
        return number;
    };
    let value;
    if (field.encoding === 'adf') value = readBcd(raw >>> 1) + (raw & 1) * .5;
    else if (field.encoding === 'bcd') {
        if (raw & ((2 ** field.shift) - 1)) throw new Error('ביטי ריפוד BCD אינם אפס');
        value = readBcd(raw >>> field.shift) * field.step;
    } else {
        const signed = field.minimum < 0 && (raw & (2 ** (field.width - 1))) ? raw - 2 ** field.width : raw;
        value = signed * field.step;
    }
    const tolerance = field.step / 1000000;
    if (value < field.minimum - tolerance || value > field.maximum + tolerance) throw new Error('ערך מחוץ לטווח הפרופיל');
    return value;
}

function decodeTraffic(event) {
    if (!/^(?:[0-9a-f]{2} ){3}[0-9a-f]{2}$/i.test(event.hex ?? '') || event.direction === 'ERROR') return null;
    const bytes = event.hex.split(' ').map(value => parseInt(value, 16));
    let word = bytes.reduce((result, byte, index) => result | (byte << (index * 8)), 0) >>> 0;
    let ones = 0;
    for (let value = word; value; value >>>= 1) ones += value & 1;
    const parityOk = ones % 2 === 1;
    const profile = event.direction === 'TX'
        ? activeJobs.find(job => job.id === event.cycleId)?.input.profile
        : null;
    const label = labels.find(item => labelKey(item) === profile);
    const data = (word >>> 10) & 0x7ffff, sdi = (word >>> 8) & 3, ssm = (word >>> 29) & 3;
    const result = { parityOk, profile: profile ?? '', data, sdi, ssm, status: '', summary: '' };
    if (!parityOk) { result.summary = 'Parity שגוי — אין להסתמך על הנתון'; return result; }
    if (!label) { result.summary = event.direction === 'RX' ? 'נתונים גולמיים — ללא פרופיל ציוד לפענוח' : 'אין פרופיל זמין'; return result; }
    if (parseInt(label.code.slice(0, 3), 8) !== bytes[0]) { result.summary = 'ה־Label אינו תואם לפרופיל שנבחר'; return result; }
    const coding = wordCoding(label);
    result.status = statusDescriptions(coding)[ssm];
    result.usable = coding === 'BNR' ? ssm === 3 : coding === 'BCD' ? [0, 3].includes(ssm) : coding === 'DSC' ? ssm === 0 : null;
    try {
        const fields = sourceFields[profile] ?? [];
        const values = fields.map(field => {
            let value = decodeNumericField(field, data, sdi);
            if (coding === 'BCD' && ssm === 3 && field.id === 'numeric') value = -value;
            return field.title + ': ' + Number(value.toPrecision(12));
        });
        result.summary = (result.usable === false ? 'נתון מסומן לבדיקה / לא תקף: ' : '')
            + (values.length ? values.join(' · ') : 'אין פענוח מספרי נתמך') + ' · ' + result.status;
    } catch (error) { result.summary = error.message + ' · ' + result.status; }
    return result;
}
