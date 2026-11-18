let sourceFields = {};
let sourceProfile = null;

function currentSourceField() {
    const label = labels.find(item => labelKey(item) === $('label').value);
    return (sourceFields[label ? labelKey(label) : ''] ?? []).find(field => field.id === $('source-field').value);
}

function updateSourceVisibility() {
    const field = currentSourceField();
    const cyclic = $('mode').value === 'cycle';
    const supported = Boolean(field);
    const kind = $('source-mode').value;
    $('source-mode').disabled = !cyclic || !supported;
    const active = cyclic && supported && kind !== 'fixed';
    $('source-options').hidden = !active;
    $('source-field-wrap').hidden = !active;
    $('source-hint').textContent = !cyclic ? 'שינוי נתונים זמין בשידור מחזורי.'
        : !supported ? 'לרשומה הזאת אין שדה מספרי נתמך לשינוי אוטומטי.'
        : `השדה: ${field.title}. טווח: ${field.minimum} עד ${field.maximum}; רזולוציה: ${field.step}.`;
    const show = (id, visible) => {
        $(id).closest('label').hidden = !visible;
        $(id).disabled = !visible;
    };
    show('source-min', active);
    show('source-max', active);
    show('source-start', active && ['ramp', 'triangle'].includes(kind));
    show('source-step', active && ['ramp', 'triangle'].includes(kind));
    show('source-samples', active && kind === 'sine');
    show('source-values', active && kind === 'sequence');
    $('source-field').disabled = !active;
}

function sourceFieldDefaults() {
    const field = currentSourceField();
    if (!field) { updateSourceVisibility(); return; }
    for (const id of ['source-min', 'source-max', 'source-start']) {
        $(id).min = field.minimum;
        $(id).max = field.maximum;
        $(id).step = field.step;
    }
    $('source-step').step = field.step;
    $('source-min').value = field.minimum;
    $('source-max').value = field.maximum;
    $('source-start').value = Math.min(field.maximum, Math.max(field.minimum, 0));
    $('source-step').value = field.step;
    $('source-values').value = String($('source-start').value);
    updateSourceVisibility();
}

function resetSourceFields(label, saved = null) {
    sourceProfile = label ? labelKey(label) : null;
    const fields = sourceFields[sourceProfile] ?? [];
    $('source-field').replaceChildren(...fields.map(field => new Option(field.title, field.id)));
    if (fields.length) $('source-field').value = saved?.field ?? fields[0].id;
    $('source-mode').value = saved?.mode ?? 'fixed';
    sourceFieldDefaults();
    $('source-samples').value = saved?.samplesPerPeriod ?? 40;
    if (saved) {
        $('source-min').value = saved.minimum;
        $('source-max').value = saved.maximum;
        $('source-start').value = saved.start;
        $('source-step').value = saved.increment;
        $('source-values').value = (saved.values ?? []).join(', ');
    }
    updateSourceVisibility();
}

function readSource() {
    if ($('mode').value !== 'cycle' || $('source-mode').value === 'fixed') return null;
    const field = currentSourceField();
    if (!field) throw new Error('בחר שדה מספרי נתמך.');
    const kind = $('source-mode').value;
    const number = id => {
        const value = $(id).valueAsNumber;
        if (!Number.isFinite(value)) throw new Error('יש להזין ערכים מספריים תקינים.');
        return value;
    };
    const minimum = number('source-min'), maximum = number('source-max');
    if (minimum > maximum) throw new Error('המינימום גדול מהמקסימום.');
    let values = null;
    if (kind === 'sequence') {
        values = $('source-values').value.trim().split(/[,;\s]+/).filter(Boolean).map(Number);
        if (!values.length || values.length > 4096 || values.some(value => !Number.isFinite(value)))
            throw new Error('יש להזין בין 1 ל־4096 ערכים, מופרדים בפסיקים או בירידות שורה.');
    }
    return {
        mode: kind, field: field.id, minimum, maximum,
        start: ['ramp', 'triangle'].includes(kind) ? number('source-start') : minimum,
        increment: ['ramp', 'triangle'].includes(kind) ? number('source-step') : field.step,
        samplesPerPeriod: kind === 'sine' ? number('source-samples') : 40,
        values
    };
}
