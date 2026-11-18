const $ = id => document.getElementById(id);
const editor = $('editor');
const history = [];
const latestTransmissions = new Map();
let selectedTrafficKey = null;
const recording = [];
const maxRows = 1000;
const maxRecordingRows = 20000;

let labels = [];
let port = null;
let cursor = 0;
let streamId = null;
let editing = null;
let editingPlan = null;
let editingRevision = null;
let selectedPlan = null;
let plans = [];
let activeJobs = [];
let plansSignature = '';
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
    sourceFields = await api('value-fields');
    for (const label of labels) $('label').add(new Option(labelTitle(label), labelKey(label)));
    renderDictionary();
    plansSignature = "";
    renderPrograms(plans, activeJobs);
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
    updateSourceVisibility();
}

function fieldInputs() {
    return [...$('gama-fields').querySelectorAll('input:not([type=range]), select')];
}

function selectLabel() {
    const label = labels.find(item => labelKey(item) === $('label').value);
    $('description').textContent = label?.description ?? '';
    readData = renderGamaFields(label);
    resetSourceFields(label);
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

function openEditor(cycle = null, planId = null) {
    editor.reset();
    editing = cycle?.id ?? null;
    editingPlan = planId ?? cycle?.planId ?? null;
    editingRevision = plans.find(p => p.id === editingPlan)?.revision ?? null;
    const input = cycle?.input;
    $('editor-title').textContent = editing ? 'עריכת הודעה' : 'הודעה חדשה';
    $('submit-message').textContent = editing ? 'שמור שינויים' : editingPlan ? 'שמור בתוכנית' : 'שלח';
    $('editor-error').textContent = '';
    $('label').value = input?.profile ?? '';
    $('mode').value = input?.hertz != null ? 'cycle' : 'once';
    $('mode').disabled = false;
    $('hz').value = input?.hertz ?? 1;
    $('sdi').value = input?.sdi ?? 0;
    $('ssm').value = input?.ssm ?? 0;
    setMode();
    selectLabel();
    if (input?.editor) restoreEditor(input.editor);
    resetSourceFields(labels.find(item => labelKey(item) === $('label').value), input?.source);
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

function rowButton(container, text, action, description = text) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = description;
    button.setAttribute('aria-label', description);
    button.addEventListener('click', action);
    container.append(button);
    return button;
}

function getPlan(id) {
    const plan = plans.find(p => p.id === id);
    if (!plan) throw new Error('התוכנית אינה קיימת.');
    return plan;
}

async function refreshPlans() {
    const snapshot = await api('board?after=' + cursor);
    updateConnection(snapshot.port);
    renderPrograms(snapshot.plans, snapshot.active);
}

function safeAction(action, errorId = 'notice') {
    return async event => {
        const button = event.currentTarget;
        button.disabled = true;
        $(errorId).textContent = '';
        try { await action(); await refreshPlans(); }
        catch (error) { $(errorId).textContent = error.message; }
        finally { button.disabled = false; }
    };
}

function itemStatus(item, job) {
    if (job?.completed) return 'נשלחה';
    if (item.paused) return 'מושהה';
    return job ? 'פועלת' : 'מוכנה להפעלה';
}

function renderItem(body, item, plan, job, errorId = 'notice') {
    const row = body.insertRow();
    const label = labels.find(l => labelKey(l) === item.input.profile);
    const title = document.createElement('bdi');
    title.dir = 'ltr';
    title.textContent = label ? labelTitle(label) : item.input.label;
    cell(row, '').append(title);
    if (body.id === 'active') cell(row, plan?.name ?? 'NULL', 'plan-name');
    const dataCell = cell(row, job?.currentData ?? item.input.data);
    dataCell.title = item.input.source ? 'מקור משתנה: ' + item.input.source.mode : 'ערך קבוע';
    row.dataset.cycleId = item.id;
    cell(row, item.input.hertz == null ? 'בודדת' : item.input.hertz + ' Hz');
    cell(row, itemStatus(item, job));
    const actions = cell(row, '');
    actions.className = 'action-cell';
    const buttons = document.createElement('div');
    buttons.className = 'row-actions';
    actions.append(buttons);
    rowButton(buttons, 'ערוך', () => openEditor(item, plan?.id ?? null));
    if (item.input.hertz != null) {
        rowButton(buttons, item.paused ? '▶️' : '⏸️', safeAction(async () => {
            const path = plan ? `plans/${plan.id}/items/${item.id}/pause` : `messages/${item.id}/pause`;
            await api(path, 'PUT', { revision: plan?.revision, paused: !item.paused });
        }, errorId), item.paused ? 'המשך שידור' : 'השהה שידור');
    }
    rowButton(buttons, '🗑️', safeAction(async () => {
        const path = plan ? `plans/${plan.id}/items/${item.id}?revision=${plan.revision}` : `messages/${item.id}`;
        await api(path, 'DELETE');
    }, errorId), 'הסר הודעה מהתוכנית');
}

function renderPrograms(saved, jobs) {
    activeJobs = jobs;
    // Update live values without replacing action buttons on every sample.
    for (const row of $('active').rows) {
        const job = jobs.find(item => item.id === row.dataset.cycleId);
        if (job && row.cells[2]) {
            row.cells[2].textContent = job.currentData ?? job.input.data;
            row.cells[2].title = job.currentValue != null ? 'ערך בשדה: ' + job.currentValue : 'Data מקודד';
        }
    }
    const signature = JSON.stringify([saved, jobs.map(({ currentData, currentValue, ...job }) => job)]);
    if (signature === plansSignature) return;
    plansSignature = signature;
    plans = saved;
    activeJobs = jobs;
    const currentIds = new Set(jobs.map(job => job.id));
    for (const [key, event] of latestTransmissions) {
        if (event.cycleId && !currentIds.has(event.cycleId)) latestTransmissions.delete(key);
    }
    renderTraffic();
    $('active').replaceChildren();
    for (const job of jobs) {
        const plan = plans.find(p => p.id === job.planId);
        const item = plan?.items.find(i => i.id === job.id);
        if (item || !job.planId) renderItem($('active'), item ?? job, plan, job);
    }
    if (!jobs.length) cell($('active').insertRow(), 'אין הודעות שהופעלו.').colSpan = 6;
    $('plans').replaceChildren();
    for (const plan of [...plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const row = $('plans').insertRow();
        row.className = 'plan-row';
        row.addEventListener('click', event => {
            if (event.target.closest('.action-cell, button')) return;
            openPlan(plan.id);
        });
        const nameCell = cell(row, '', 'plan-name');
        const planButton = rowButton(nameCell, plan.name, () => openPlan(plan.id), 'פתח את ' + plan.name);
        planButton.dir = 'ltr';
        planButton.className = 'plan-row-button';
        cell(row, new Date(plan.createdAt).toLocaleDateString('he-IL'));
        cell(row, new Date(plan.createdAt).toLocaleTimeString('he-IL', { hour12: false }));
        cell(row, plan.items.length);
        const running = jobs.filter(j => j.planId === plan.id && !j.paused && !j.completed).length;
        const status = cell(row, '');
        const statusText = document.createElement('bdi');
        statusText.dir = 'rtl';
        const fraction = document.createElement('bdi');
        fraction.dir = 'ltr';
        fraction.textContent = `${running}/${plan.items.length}`;
        statusText.append(running ? 'משדרת (' : 'שמורה (', fraction, ')');
        status.append(statusText);
        const actions = cell(row, '');
        actions.className = 'action-cell';
        const buttons = document.createElement('div');
        buttons.className = 'row-actions';
        actions.append(buttons);
        rowButton(buttons, 'מחק תוכנית', safeAction(async () => {
            if (!confirm('למחוק את התוכנית ולהפסיק את כל השידורים שלה?')) return;
            await api(`plans/${plan.id}?revision=${plan.revision}`, 'DELETE');
        }, 'history-error'));
    }
    if (!plans.length) cell($('plans').insertRow(), 'אין תוכניות שמורות.').colSpan = 6;
    renderPlanEditor();
}

function openPlan(id) {
    if ($('plan-history-dialog').open) $('plan-history-dialog').close();
    selectedPlan = id;
    $('plan-error').textContent = '';
    renderPlanEditor();
    $('plan-dialog').showModal();
}

function renderPlanEditor() {
    const plan = plans.find(p => p.id === selectedPlan);
    if (!plan) {
        if ($('plan-dialog').open) $('plan-dialog').close();
        return;
    }
    $('plan-title').textContent = 'תוכנית שליחה — ' + plan.name;
    $('plan-items').replaceChildren();
    for (const item of plan.items) {
        renderItem($('plan-items'), item, plan, activeJobs.find(j => j.id === item.id), 'plan-error');
    }
    if (!plan.items.length) cell($('plan-items').insertRow(), 'הוסף הודעות לתוכנית.').colSpan = 5;
    $('activate-plan').disabled = !port || plan.items.length === 0;
}

function trafficKey(event) {
    return event.direction === 'TX' ? 'TX:' + (event.cycleId ?? 'untracked') : event.direction;
}

function showEvent(event) {
    selectedTrafficKey = trafficKey(event);
    const fields = [event.time, event.direction, event.label, event.cycleId, event.hex, event.error,
        event.packetId ? 'מזהה חבילה: ' + event.packetId : null,
        event.wordCount != null ? 'מילים בחבילה: ' + event.wordCount : null,
        event.checksum ? 'Checksum: ' + event.checksum : null,
        event.packetHex ? 'חבילת UART מלאה: ' + event.packetHex : null];
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
    cell(row, event.wordCount ?? '—');
    cell(row, event.hex || event.error || '—', event.hex ? 'hex' : null);
    row.addEventListener('click', () => showEvent(event));
    row.addEventListener('keydown', eventKey => {
        if (eventKey.key === 'Enter') showEvent(event);
    });
}

function renderTraffic() {
    $('traffic').replaceChildren();
    const direction = $('direction').value;
    const filter = $('filter-label').value.trim();
    const matches = event => (!direction || event.direction === direction)
        && (!filter || String(event.label ?? '').startsWith(filter));
    const visible = [...latestTransmissions.values()].filter(matches);
    // Received packets do not carry our scheduler's CycleId. Keep RX and errors
    // as latest-event views without inventing a link to a local transmission.
    for (const other of ['RX', 'ERROR']) {
        if (direction && direction !== other) continue;
        const latest = history.findLast(event => event.direction === other && matches(event));
        if (latest) visible.push(latest);
    }
    visible.sort((a, b) => a.sequence - b.sequence);
    if (visible.length) {
        visible.forEach(addTrafficRow);
        showEvent(visible.find(event => trafficKey(event) === selectedTrafficKey) ?? visible.at(-1));
    } else {
        cell($('traffic').insertRow(), 'אין אירוע שתואם לסינון.').colSpan = 6;
        $('selected-event').textContent = '';
    }
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
    $('new-plan').disabled = labels.length === 0;
    const plan = plans.find(p => p.id === selectedPlan);
    $('activate-plan').disabled = !port || !plan?.items.length;
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
}

function appendEvents(events) {
    for (const event of events) {
        cursor = event.sequence;
        history.push(event);
        if (event.direction === 'TX' && (!event.cycleId || activeJobs.some(job => job.id === event.cycleId))) {
            latestTransmissions.set(trafficKey(event), event);
        }
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

    if (history.length > maxRows) history.splice(0, history.length - maxRows);
    renderTraffic();
}

async function poll() {
    try {
        const requestedAt = new Date();
        const snapshot = await api('board?after=' + cursor);
        if (streamId && streamId !== snapshot.streamId) {
            cursor = 0;
            history.length = 0;
            latestTransmissions.clear();
            selectedTrafficKey = null;
            renderTraffic();
            if (recordingOn) hasGap = true;
            $('selected-event').textContent = 'בחר שורה כדי לראות את הפרטים שלה.';
            pollDelay = 0;
            streamId = snapshot.streamId;
            return;
        }
        streamId = snapshot.streamId;
        updateConnection(snapshot.port);
        renderPrograms(snapshot.plans, snapshot.active);

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
$('source-mode').addEventListener('change', updateSourceVisibility);
$('source-field').addEventListener('change', sourceFieldDefaults);
$('direction').addEventListener('change', renderTraffic);
$('filter-label').addEventListener('input', renderTraffic);
$('search').addEventListener('input', renderDictionary);
$('new-message').addEventListener('click', () => openEditor());
$('open-dictionary').addEventListener('click', () => $('dictionary-dialog').showModal());
$('open-plan-history').addEventListener('click', () => {
    $('history-error').textContent = '';
    $('plan-history-dialog').showModal();
});
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
        hertz, editor: editorValues(), source: readSource()
    };
    if (editingPlan) {
        const path = `plans/${editingPlan}/items` + (editing ? '/' + editing : '');
        await api(path, editing ? 'PUT' : 'POST', { revision: editingRevision, input: payload });
    } else {
        await api(editing ? 'messages/' + editing : 'messages', editing ? 'PUT' : 'POST', payload);
    }
    await refreshPlans();
    $('editor-dialog').close();
});
bind('new-plan', 'click', 'notice', async () => {
    const plan = await api('plans', 'POST');
    await refreshPlans();
    openPlan(plan.id);
});
$('add-plan-message').addEventListener('click', () => openEditor(null, selectedPlan));
bind('activate-plan', 'click', 'plan-error', async () => {
    const plan = getPlan(selectedPlan);
    await api(`plans/${plan.id}/activate`, 'POST', { revision: plan.revision });
    await refreshPlans();
    $('plan-dialog').close();
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
