const $ = id => document.getElementById(id);
const editor = $('editor');
const trafficPane = $('traffic').closest('.traffic');

const history = [];
const recordedEvents = [];
const maxVisibleEvents = 1000;
const maxRecordedEvents = 20000;

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

async function api(path, method = 'GET', body) {
    const options = { method, cache: 'no-store' };

    if (body !== undefined) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
    }

    const response = await fetch('/api/' + path, options);
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(result.error ?? result.detail ?? 'הבקשה נכשלה.');
    }

    return result;
}

function bind(id, eventName, errorId, action) {
    let busy = false;

    $(id).addEventListener(eventName, async event => {
        event.preventDefault();
        if (busy) return;

        busy = true;
        $(errorId).textContent = '';

        try {
            await action(event);
        } catch (error) {
            $(errorId).textContent = error.message;
        } finally {
            busy = false;
        }
    });
}

function labelKey(label) {
    return [label.code, (label.equipment ?? []).join(','),
        label.section ?? '', label.page ?? ''].join('|');
}

function labelTitle(label) {
    const equipment = label.equipment?.length
        ? ' · ציוד ' + label.equipment.join(', ')
        : '';

    return label.code + ' — ' + label.name + equipment;
}

function currentLabel() {
    return labels.find(label => labelKey(label) === $('label').value);
}

async function loadLabels() {
    const response = await fetch('labels.json', { cache: 'no-store' });

    if (!response.ok) {
        throw new Error('טעינת מילון GAMA 11 נכשלה.');
    }

    labels = await response.json();
    for (const label of labels) {
        $('label').add(new Option(labelTitle(label), labelKey(label)));
    }

    renderDictionary();
    updateConnection(port);
}

function renderDictionary() {
    const query = $('search').value.trim().toLowerCase();
    const items = [];

    for (const label of labels) {
        const text = [labelTitle(label), label.description || label.note]
            .filter(Boolean).join(' · ');

        if (!text.toLowerCase().includes(query)) continue;

        const item = document.createElement('li');
        item.textContent = text;
        items.push(item);
    }

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
    const label = currentLabel();
    $('description').textContent = label?.description ?? '';
    readData = renderGamaFields(label);
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

    input?.editor?.forEach((saved, index) => {
        // בחירת מצב עשויה להחליף את השדות הבאים בטופס.
        const field = fieldInputs()[index];
        if (!field) return;

        field.value = saved.value;
        field.checked = saved.checked;
        field.dispatchEvent(new Event(field.type === 'checkbox' ? 'change' : 'input'));
    });

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

function actionButton(container, text, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', handler);
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

        cell(row, label ? labelTitle(label) : cycle.input.label);
        cell(row, cycle.input.data);
        cell(row, cycle.input.hertz + ' Hz');

        const actions = cell(row, '');
        actions.className = 'actions';

        actionButton(actions, 'ערוך', () => openEditor(cycle));

        const stop = actionButton(actions, 'עצור', async () => {
            stop.disabled = true;

            try {
                await api('messages/' + cycle.id, 'DELETE');
            } catch (error) {
                $('notice').textContent = error.message;
            } finally {
                stop.disabled = false;
            }
        });
    }
}

const localTime = new Intl.DateTimeFormat('he-IL', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
});

function addTrafficRow(event) {
    const direction = $('direction').value;
    if (direction && direction !== event.direction) return;

    const row = $('traffic').insertRow();
    row.dataset.direction = event.direction;
    row.tabIndex = 0;

    cell(row, event.sequence);
    cell(row, localTime.format(new Date(event.time)), 'time');
    cell(row, event.direction);
    cell(row, event.label ?? '—');
    cell(row, event.hex || event.error || '—', event.hex ? 'hex' : null);

    function showDetails() {
        $('selected-event').textContent = [
            event.time, event.direction, event.label,
            event.cycleId, event.hex, event.error
        ].filter(Boolean).join(' · ');
    }

    row.addEventListener('click', showDetails);
    row.addEventListener('keydown', key => {
        if (key.key === 'Enter') showDetails();
    });
}

function scrollToLatest() {
    if ($('follow').checked) trafficPane.scrollTop = trafficPane.scrollHeight;
}

function renderTraffic() {
    $('traffic').replaceChildren();
    history.forEach(addTrafficRow);
    scrollToLatest();
}

function updateConnection(value) {
    port = value;

    const button = $('open-connection');
    const caption = port ? 'מחובר ל־' + port : 'מנותק';

    if (button.textContent !== caption) {
        if (port) {
            const name = document.createElement('bdi');
            name.textContent = port;
            button.replaceChildren('מחובר ל־', name);
        } else {
            button.textContent = caption;
        }
    }

    button.dataset.connected = String(Boolean(port));
    button.setAttribute('aria-label', caption + '. פתח הגדרות חיבור UART');

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

    $('connection-error').textContent = names.length ? '' : 'לא נמצאו פורטים.';
}

function setRecording(value) {
    recordingOn = value;
    $('record').textContent = value ? 'עצור הקלטה' : 'התחל הקלטה';
    $('export').disabled = recordingOn || !recordingEndedAt;
}

function exportRecording() {
    if (recordingOn || !recordingStartedAt || !recordingEndedAt) return;

    try {
        downloadRecordingWorkbook(
            recordedEvents, recordingStartedAt, recordingEndedAt, hasGap
        );
    } catch (error) {
        $('notice').textContent = 'יצירת קובץ Excel נכשלה. ' + error.message;
    }
}

function finishRecording() {
    setRecording(false);
    $('record').disabled = false;
    exportRecording();
}

function appendEvents(events) {
    for (const event of events) {
        cursor = event.sequence;
        history.push(event);
        addTrafficRow(event);

        const time = new Date(event.time);
        if (recordingOn && time >= recordingStartedAt
            && (!recordingEndedAt || time <= recordingEndedAt)) {
            recordedEvents.push(event);

            if (recordedEvents.length >= maxRecordedEvents) {
                recordingEndedAt ??= time;
                hasGap = true;
                finishRecording();

                $('notice').textContent =
                    'ההקלטה נעצרה לאחר 20,000 אירועים. אפשר להוריד את הקובץ שוב.';
            }
        }
    }

    if (history.length > maxVisibleEvents) {
        const removed = history.splice(0, history.length - maxVisibleEvents);
        const lastRemoved = removed.at(-1).sequence;
        const rows = $('traffic').rows;

        while (rows.length && Number(rows[0].cells[0].textContent) <= lastRemoved) {
            rows[0].remove();
        }
    }

    scrollToLatest();
}

async function poll() {
    let delay = 150;

    try {
        const requestedAt = new Date();
        const snapshot = await api('board?after=' + cursor);

        if (streamId && streamId !== snapshot.streamId) {
            cursor = 0;
            history.length = 0;
            renderTraffic();

            $('selected-event').textContent = 'בחר שורה כדי לראות את הפרטים שלה.';
            if (recordingOn) hasGap = true;

            streamId = snapshot.streamId;
            delay = 0;
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

        if (snapshot.events.length === 500) delay = 0;
    } catch (error) {
        $('notice').textContent = error.message;
        delay = 600;
    } finally {
        window.setTimeout(poll, delay);
    }
}

$('label').addEventListener('change', selectLabel);
$('mode').addEventListener('change', setMode);
$('direction').addEventListener('change', renderTraffic);
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
    const selectedPort = fields.get('port');

    await api('connect', 'POST', {
        port: selectedPort,
        baudRate: Number(fields.get('baudRate')),
        parity: fields.get('parity'),
        stopBits: Number(fields.get('stopBits'))
    });

    updateConnection(selectedPort);
    $('connection-dialog').close();
});

bind('disconnect', 'click', 'connection-error', async () => {
    await api('disconnect', 'POST');
    updateConnection(null);
    $('connection-dialog').close();
});

bind('editor', 'submit', 'editor-error', async () => {
    const label = currentLabel();
    const data = label ? readData() : null;
    if (data === null) return;

    const payload = {
        profile: labelKey(label),
        label: label.code.slice(0, 3),
        data,
        sdi: Number($('sdi').value),
        ssm: Number($('ssm').value),
        hertz: $('mode').value === 'cycle' ? $('hz').valueAsNumber : null,
        editor: fieldInputs().map(field => ({
            value: field.value,
            checked: Boolean(field.checked)
        }))
    };

    await api(editing ? 'messages/' + editing : 'messages',
        editing ? 'PUT' : 'POST', payload);

    $('editor-dialog').close();
});

$('record').addEventListener('click', () => {
    if (recordingOn) {
        recordingEndedAt = new Date();
        $('record').disabled = true;
        $('record').textContent = 'מסיים הקלטה…';
        return;
    }

    if (recordedEvents.length && !window.confirm('להחליף את ההקלטה הקיימת?')) return;

    recordedEvents.length = 0;
    recordingStartedAt = new Date();
    recordingEndedAt = null;
    hasGap = false;
    setRecording(true);
});

$('export').addEventListener('click', exportRecording);

loadLabels().catch(error => { $('notice').textContent = error.message; });
poll();