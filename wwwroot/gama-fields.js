const decimalProfiles = {
    '001': ['מרחק ליעד במיילים ימיים', 0, 3999.9, 0.1, v => bcd(Math.round(v * 10))],
    '002': ['זמן ליעד בדקות', 0, 399.9, 0.1, v => bcd(Math.round(v * 10)) << 4],
    '012': ['מהירות קרקע בקשרים', 0, 7999.9, 0.1, v => bcd(Math.round(v * 10))],
    '017': ['כיוון מסלול במעלות', 0, 359.9, 0.1, v => bcd(Math.round(v * 10)) << 4],
    '210': ['מהירות אוויר אמיתית בקשרים', 0, 2047.9375, 0.0625, v => Math.round(v * 16) << 3],
    '327G': ['קנה מידה אנכי ברגל', -2048, 2047.9375, 0.0625,
        v => (Math.round(v * 16) & 0xffff) << 3]
};

const decimalEquipment = {
    '001': ['02', '09'], '002': ['02', '09'], '012': ['02', '09'],
    '017': ['10'], '210': ['02'], '327G': ['02']
};

function bcd(value) {
    let result = 0;
    for (let offset = 0; value > 0; offset += 4) {
        result |= (value % 10) << offset;
        value = Math.floor(value / 10);
    }
    return result;
}

function numericControl(panel, name, min, max, step, sliderEnabled = false) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(min <= 0 && max >= 0 ? 0 : min);
    input.required = true;

    const label = document.createElement('label');
    label.append(`${name} · ${min} עד ${max} · צעד ${step}`, input);
    panel.append(label);

    if (sliderEnabled) {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = input.min;
        slider.max = input.max;
        slider.step = input.step;
        slider.value = input.value;
        slider.setAttribute('aria-label', name);
        slider.oninput = () => { input.value = slider.value; };
        input.oninput = () => {
            if (input.validity.valid) slider.value = input.value;
        };
        panel.append(slider);
    }

    return () => input.reportValidity() ? input.valueAsNumber : null;
}

function flagControl(panel, name, onChange) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    if (onChange) input.addEventListener('change', onChange);
    const label = document.createElement('label');
    label.className = 'gama-flag';
    label.append(input, name);
    panel.append(label);
    return () => Number(input.checked);
}

function text(panel, value) {
    const line = document.createElement('p');
    line.textContent = value;
    panel.append(line);
}

function encodeAdf(khz, bfo, adf) {
    return (bcd(Math.floor(khz)) << 4)
        | ((Math.round(khz * 2) % 2) << 3)
        | (adf << 1) | bfo;
}

function cabinControls(panel) {
    const alternate = flagControl(panel, 'מצב חלופי · ביט 29', renderFormat);
    const announce = flagControl(panel, 'הצג הודעה בתא הנוסעים · ביט 23');
    const format = document.createElement('div');
    panel.append(format);
    let readFormat;

    function renderFormat() {
        format.replaceChildren();

        if (alternate()) {
            const play = numericControl(format, 'מספר תדריך להפעלה (0 = ללא פקודה)', 0, 63, 1);
            const cancel = numericControl(format, 'מספר תדריך לביטול (0 = ללא פקודה)', 0, 63, 1);
            readFormat = () => {
                const a = play();
                const b = cancel();
                return a === null || b === null ? null : a | (b << 6) | (1 << 18);
            };
        } else {
            const flags = ['הפעל', 'בטל'].flatMap(action =>
                Array.from({ length: 6 }, (_, index) =>
                    flagControl(format, `${action} תדריך ${index + 1}`)));
            readFormat = () => flags.reduce((bits, read, index) => bits | (read() << index), 0);
        }
    }

    renderFormat();

    return () => {
        const fields = readFormat();
        return fields === null ? null : fields | (announce() << 12);
    };
}

function hasStandardEnvelope(fields) {
    const matches = (first, last, pattern) =>
        fields.some(field => field.first === first && field.last === last && pattern.test(field.name));

    const bits = fields.flatMap(({ first, last }) =>
        Array.from({ length: last - first + 1 }, (_, index) => first + index));

    return bits.length === 32 && bits.every((bit, index) => bit === index + 1)
        && matches(1, 8, /LABEL/i) && matches(9, 10, /^SDI/i)
        && matches(30, 31, /SSM|SIGN\s*\/\s*STATUS MATRIX/i)
        && matches(32, 32, /PARITY/i);
}

function rawFieldEditor(panel, fields) {
    text(panel, 'עריכה לפי ביטים. הטווחים כאן מייצגים את קיבולת השדות; כללי התקינות של ההודעה מופיעים במקור.');
    const controls = [];

    for (const { first, last, name } of fields) {
        if (first < 11 || last > 29) continue;
        const title = `ביטים ${first}–${last} · ${name}`;

        if (/^SPARES?\b|\bRESERVED\b|\bPAD ZERO\b|\bALWAYS ZERO\b/i.test(name)) {
            text(panel, title + ' · 0');
            continue;
        }

        const capacity = (2 ** (last - first + 1)) - 1;
        const decimalDigit = /^(THOUSANDTHS|HUNDREDTHS|TENTHS|UNITS|TENS|HUNDREDS|THOUSANDS) OF\b/i.test(name);
        const max = decimalDigit ? Math.min(capacity, 9) : capacity;
        const read = max === 1
            ? flagControl(panel, title)
            : numericControl(panel, title, 0, max, 1);

        controls.push({ offset: first - 11, read });
    }

    return () => {
        let value = 0;
        for (const { offset, read } of controls) {
            const field = read();
            if (field === null) return null;
            value |= field << offset;
        }
        return value;
    };
}

function packNumericBnr(ticks, firstBit) {
    // Build bits 9–29 together, then split them for the existing API.
    const width = 30 - firstBit;
    const encoded = (ticks & ((1 << width) - 1)) << (firstBit - 9);
    return { data: encoded >>> 2, sdi: encoded & 3 };
}

function renderNumericBnr(panel, profile) {
    const { title, first, step, minTick, maxTick } = profile;
    const read = numericControl(panel, title, minTick * step, maxTick * step, step, true);
    const flags = (profile.flags ?? []).map(([bit, name]) =>
        ({ bit, read: flagControl(panel, name) }));

    return () => {
        const value = read();
        if (value === null) return null;

        const ticks = Math.round(value / step);
        if (ticks < minTick || ticks > maxTick) return null;
        const encoded = packNumericBnr(ticks, first);

        for (const flag of flags) {
            encoded.data |= flag.read() << (flag.bit - 11);
        }

        return first < 11 ? encoded : encoded.data;
    };
}

function renderGamaFields(label) {
    const panel = document.getElementById('gama-fields');
    const labelSelect = document.getElementById('label');

    for (const id of ['data', 'slider']) {
        const input = document.getElementById(id);
        input.disabled = true;
        input.closest('label').hidden = true;
    }

    labelSelect.setCustomValidity('');
    document.getElementById('sdi').disabled = Boolean(label?.numericBnr?.first < 11);
    panel.replaceChildren();
    if (!label) return () => null;

    if (label.arincPage) text(panel, `ARINC 429 Part 1-17 · Attachment 2, Table 2 · עמוד מודפס ${label.arincPage}`);
    if (label.page) text(panel, `GAMA 11 · ${label.section} · עמוד PDF ${label.page}`);
    if (label.note) text(panel, label.note);

    if (label.numericBnr) return renderNumericBnr(panel, label.numericBnr);

    const match = (code, equipment) => label.code === code
        && label.equipment?.length === 1 && equipment.includes(label.equipment[0])
        && label.section === '3.1';

    if (match('277G', ['02'])) {
        text(panel, 'SSM: 00 פעולה תקינה · 01 נתון לא זמין · 10 בדיקה · 11 אזהרת תקלה.');
        return cabinControls(panel);
    }

    if (match('032', ['02', '12'])) {
        const frequency = numericControl(panel, 'תדר ADF בקילוהרץ', 190, 1750, 0.5, true);
        const bfo = flagControl(panel, 'BFO פעיל · ביט 11');
        const mode = flagControl(panel, 'מצב ADF (כבוי = Antenna) · ביט 12');
        return () => {
            const value = frequency();
            return value === null ? null : encodeAdf(value, bfo(), mode());
        };
    }

    const profile = decimalProfiles[label.code];
    if (profile && match(label.code, decimalEquipment[label.code])) {
        const [name, min, max, step, encode] = profile;
        const read = numericControl(panel, name, min, max, step, true);
        return () => {
            const value = read();
            return value === null ? null : encode(value);
        };
    }

    const fields = label.fields ?? [];
    if (hasStandardEnvelope(fields) && !/PRIVATE USE|USER DEFINED|PER GAMA|PER A429/i.test(label.note ?? '')) {
        return rawFieldEditor(panel, fields);
    }

    const reason = 'לקידוד הרשומה הזאת חסרה הגדרה מאומתת או נדרשת תמיכה במבנה מילה שונה.';
    text(panel, reason);
    for (const { first, last, name } of fields) {
        text(panel, `${first}–${last} · ${name}`);
    }

    labelSelect.setCustomValidity(reason);
    return () => null;
}
