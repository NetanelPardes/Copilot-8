const $ = id => document.getElementById(id);
const editor = $('editor');
const board = $('traffic').closest('.traffic');
const history = [];
const recording = [];
const maxRows = 1000;
const maxRecordingRows = 20000;

let labels = [];
let port = null;
let cursor = 0;
let streamId = null;
let activeSignature = '';
let editing = null;
let readData = () => null;
let recordingOn = false;
let recordingStartedAt = null;
let recordingEndedAt = null;
let hasGap = false;
let pollDelay = 150;

async function api(path, method = 'GET', body) {
    const options = { method, cache: 'no-store' };
    if (body !== undefined) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
    }
    const response = await fetch('/api/' + path, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? result.detail ?? 'הבקשה נכשלה.');
    return result;
}

function bind(id, eventName, errorId, action) {
    let busy = false;
    $(id).addEventListener(eventName, async event => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        $(errorId).textContent = '';
        try { await action(event); }
        catch (error) { $(errorId).textContent = error.message; }
        finally { busy = false; }
    });
}

function labelKey(label) {
    return [label.code, (label.equipment ?? []).join(','), label.section ?? '', label.page ?? ''].join('|');
}

function labelTitle(label) {
    const equipment = label.equipment?.length ? ' · ציוד ' + label.equipment.join(', ') : '';
    return label.code + ' - ' + label.name + equipment;
}

async function loadLabels() {
    const response = await fetch('labels.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('טעינת מילון GAMA 11 נכשלה.');
    labels = await response.json();
    for (const label of labels) $('label').add(new Option(labelTitle(label), labelKey(label)));
    renderDictionary();
    updateConnection(port);
}

function renderDictionary() {
    const query = $('search').value.trim().toLowerCase();
    const rows = labels.filter(label =>
        (labelTitle(label) + ' ' + (label.description ?? label.note ?? '')).toLowerCase().includes(query));
    const items = rows.map(label => {
        const row = document.createElement('li');
        const title = document.createElement('bdi');
        title.dir = 'ltr';
        title.textContent = labelTitle(label);
        row.append(title);

        if (label.note) {
            row.append(' · ', label.note);
        }
        return row;
    });
    $('dictionary').replaceChildren(...items);
}

function setMode() {
    const cyclic = $('mode').value === 'cycle';
    $('frequency-field').hidden = !cyclic;
    $('hz').disabled = !cyclic;
}

function fieldInputs() {
    return [...$('gama-fields').querySelectorAll('input:not([type=range]), select')];
}

function selectLabel() {
    const label = labels.find(item => labelKey(item) === $('label').value);
    $('description').textContent = label?.description ?? '';
    readData = renderGamaFields(label);
}

function editorValues() {
    return fieldInputs().map(input => ({ value: input.value, checked: input.checked }));
}

function restoreEditor(values) {
    values.forEach((saved, index) => {
        // A format checkbox may replace the fields that follow it.
        const input = fieldInputs()[index];
        if (!input) return;
        input.value = saved.value;
        input.checked = saved.checked;
        input.dispatchEvent(new Event(input.type === 'checkbox' ? 'change' : 'input'));
    });
}

function openEditor(cycle = null) {
    editor.reset();
    editing = cycle?.id ?? null;
    const input = cycle?.input;
    $('editor-title').textContent = editing ? 'עריכת שידור מחזורי' : 'הודעה חדשה';
    $('submit-message').textContent = editing ? 'שמור שינויים' : 'שלח';
    $('editor-error').textContent = '';
    $('label').value = input?.profile ?? '';
    $('mode').value = editing ? 'cycle' : 'once';
    $('mode').disabled = Boolean(editing);
    $('hz').value = input?.hertz ?? 1;
    $('sdi').value = input?.sdi ?? 0;
    $('ssm').value = input?.ssm ?? 0;
    setMode();
    selectLabel();
    if (input?.editor) restoreEditor(input.editor);
    $('editor-dialog').showModal();
}

function cell(row, text, className) {
    const td = row.insertCell();
    td.textContent = text;
    if (className) {
        td.className = className;
        td.dir = 'ltr';
    }
    return td;
}

function rowButton(container, text, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', action);
    container.append(button);
    return button;
}

function renderActive(active) {
    const signature = JSON.stringify(active);
    if (signature === activeSignature) return;
    activeSignature = signature;
    const body = $('active');
    body.replaceChildren();

    if (!active.length) {
        cell(body.insertRow(), 'אין שידורים מחזוריים פעילים.').colSpan = 4;
        return;
    }

    for (const cycle of active) {
        const row = body.insertRow();
        const label = labels.find(item => labelKey(item) === cycle.input.profile);
        const labelCell = cell(row, '');
        const title = document.createElement('bdi');
        title.dir = 'ltr';
        title.textContent = label ? labelTitle(label) : cycle.input.label;
        labelCell.append(title);
        cell(row, String(cycle.input.data));
        cell(row, cycle.input.hertz + ' Hz');
        const actions = cell(row, '');
        actions.className = 'actions';
        rowButton(actions, 'ערוך', () => openEditor(cycle));
        const stop = rowButton(actions, 'עצור', async () => {
            stop.disabled = true;
            try { await api('messages/' + cycle.id, 'DELETE'); }
            catch (error) { $('notice').textContent = error.message; }
            finally { stop.disabled = false; }
        });
    }
}

function showEvent(event) {
    const fields = [event.time, event.direction, event.label, event.cycleId, event.hex, event.error];
    $('selected-event').textContent = fields.filter(Boolean).join(' · ');
}

function addTrafficRow(event) {
    if ($('direction').value && $('direction').value !== event.direction) return;
    const filter = $('filter-label').value.trim();
    if (filter && !String(event.label ?? '').startsWith(filter)) return;
    const row = $('traffic').insertRow();
    row.dataset.direction = event.direction;
    row.tabIndex = 0;
    cell(row, event.sequence);
    cell(row, new Date(event.time).toLocaleTimeString('he-IL', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
    }), 'time');
    cell(row, event.direction);
    cell(row, event.label ?? '—');
    cell(row, event.hex || event.error || '—', event.hex ? 'hex' : null);
    row.addEventListener('click', () => showEvent(event));
    row.addEventListener('keydown', eventKey => {
        if (eventKey.key === 'Enter') showEvent(event);
    });
}

function renderTraffic() {
    $('traffic').replaceChildren();
    history.forEach(addTrafficRow);
    if ($('follow').checked) board.scrollTop = board.scrollHeight;
}

function updateConnection(value) {
    port = value;
    const connectionButton = $('open-connection');
    const state = String(Boolean(port));
    const label = port ? `מחובר ל־${port}` : 'מנותק';

    if (connectionButton.textContent !== label) {
        if (port) {
            const portName = document.createElement('bdi');
            portName.textContent = port;
            connectionButton.replaceChildren('מחובר ל־', portName);
        } else {
            connectionButton.textContent = label;
        }
    }

    connectionButton.dataset.connected = state;
    connectionButton.setAttribute('aria-label', label + '. פתח הגדרות חיבור UART');
    $('new-message').disabled = !port || labels.length === 0;
    $('connect').disabled = Boolean(port);
    $('disconnect').disabled = !port;
}

async function loadPorts() {
    const names = await api('ports');
    const select = $('port');
    const previous = select.value || port;
    select.replaceChildren(new Option('בחר פורט', ''));
    for (const name of names) select.add(new Option(name, name));
    if (names.includes(previous)) select.value = previous;
    if (!names.length) $('connection-error').textContent = 'לא נמצאו פורטים.';
}

function setRecording(value) {
    recordingOn = value;
    $('record').textContent = value ? 'עצור הקלטה' : 'התחל הקלטה';
    $('export').disabled = recordingOn || !recordingEndedAt;
}

function appendEvents(events) {
    for (const event of events) {
        cursor = event.sequence;
        history.push(event);
        addTrafficRow(event);
        const eventTime = new Date(event.time);
        if (recordingOn && eventTime >= recordingStartedAt
            && (!recordingEndedAt || eventTime <= recordingEndedAt)) {
            recording.push(event);
            if (recording.length >= maxRecordingRows) {
                recordingEndedAt ??= new Date();
                hasGap = true;
                finishRecording();
                $('notice').textContent = 'ההקלטה נעצרה לאחר 20,000 אירועים. אפשר להוריד את הקובץ.';
            }
        }
    }

    if (history.length > maxRows) {
        const removed = history.splice(0, history.length - maxRows);
        const lastRemoved = removed.at(-1).sequence;
        const rows = $('traffic').rows;
        while (rows.length && Number(rows[0].cells[0].textContent) <= lastRemoved) {
            rows[0].remove();
        }
    }

    $('export').disabled = recordingOn || !recordingEndedAt;
    if ($('follow').checked) board.scrollTop = board.scrollHeight;
}

async function poll() {
    try {
        const requestedAt = new Date();
        const snapshot = await api('board?after=' + cursor);
        if (streamId && streamId !== snapshot.streamId) {
            cursor = 0;
            history.length = 0;
            renderTraffic();
            if (recordingOn) hasGap = true;
            $('selected-event').textContent = 'בחר שורה כדי לראות את הפרטים שלה.';
            pollDelay = 0;
            streamId = snapshot.streamId;
            return;
        }
        streamId = snapshot.streamId;
        updateConnection(snapshot.port);
        renderActive(snapshot.active);

        if (snapshot.lost > 0) {
            if (recordingOn) hasGap = true;
            $('notice').textContent = 'חלק מהאירועים כבר יצאו ממאגר השרת.';
        }

        if (snapshot.events.length) appendEvents(snapshot.events);
        if (recordingOn && recordingEndedAt && requestedAt >= recordingEndedAt
            && snapshot.events.length < 500) {
            finishRecording();
        }
        pollDelay = snapshot.events.length === 500 ? 0 : 150;
    } catch (error) {
        $('notice').textContent = error.message;
        pollDelay = 600;
    } finally {
        window.setTimeout(poll, pollDelay);
    }
}

$('label').replaceChildren(new Option('בחר Label', ''));
$('label').addEventListener('change', selectLabel);
$('mode').addEventListener('change', setMode);
$('direction').addEventListener('change', renderTraffic);
$('filter-label').addEventListener('input', renderTraffic);
$('search').addEventListener('input', renderDictionary);
$('new-message').addEventListener('click', () => openEditor());
$('open-dictionary').addEventListener('click', () => $('dictionary-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button => {
    button.addEventListener('click', () => button.closest('dialog').close());
});

bind('open-connection', 'click', 'connection-error', async () => {
    $('connection-dialog').showModal();
    await loadPorts();
});
bind('refresh-ports', 'click', 'connection-error', loadPorts);
bind('connection-form', 'submit', 'connection-error', async () => {
    const fields = new FormData($('connection-form'));
    await api('connect', 'POST', {
        port: fields.get('port'), baudRate: Number(fields.get('baudRate')),
        parity: fields.get('parity'), stopBits: Number(fields.get('stopBits'))
    });
    updateConnection(fields.get('port'));
    $('connection-dialog').close();
});
bind('disconnect', 'click', 'connection-error', async () => {
    await api('disconnect', 'POST');
    updateConnection(null);
    $('connection-dialog').close();
});

bind('editor', 'submit', 'editor-error', async () => {
    const label = labels.find(item => labelKey(item) === $('label').value);
    const encoded = label ? readData() : null;
    if (encoded === null) return;

    // Some ARINC labels extend the data field into the SDI positions.
    const { data, sdi } = typeof encoded === 'number'
        ? { data: encoded, sdi: Number($('sdi').value) }
        : encoded;

    const hertz = $('mode').value === 'cycle' ? $('hz').valueAsNumber : null;
    const payload = {
        profile: labelKey(label), label: label.code.slice(0, 3), data,
        sdi, ssm: Number($('ssm').value),
        hertz, editor: editorValues()
    };
    await api(editing ? 'messages/' + editing : 'messages', editing ? 'PUT' : 'POST', payload);
    $('editor-dialog').close();
});
$('record').addEventListener('click', () => {
    if (recordingOn) {
        recordingEndedAt = new Date();
        $('record').disabled = true;
        $('record').textContent = 'מסיים הקלטה…';
        return;
    }

    if (recording.length && !window.confirm('להחליף את ההקלטה הקיימת?')) return;
    recording.length = 0;
    recordingStartedAt = new Date();
    recordingEndedAt = null;
    hasGap = false;
    setRecording(true);
});

$('export').addEventListener('click', exportRecording);

function exportRecording() {
    if (recordingOn || !recordingStartedAt || !recordingEndedAt) return;

    try {
        downloadRecordingWorkbook(recording, recordingStartedAt, recordingEndedAt, hasGap);
    } catch (error) {
        $('notice').textContent = 'יצירת קובץ Excel נכשלה. ' + error.message;
    }
}

function finishRecording() {
    setRecording(false);
    $('record').disabled = false;
    exportRecording();
}

loadLabels().catch(error => { $('notice').textContent = error.message; });
poll();
