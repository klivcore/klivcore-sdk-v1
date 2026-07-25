// packages/components/src/index.ts
function projectPortTimeline(history, endAt, windowMs) {
  const startAt = endAt - windowMs;
  return Object.freeze((history?.intervals ?? []).filter((interval) => interval.startedAt < endAt && (interval.endedAt ?? endAt) > startAt).map((interval) => Object.freeze({
    port: interval.port,
    startAt: Math.max(startAt, interval.startedAt),
    endAt: Math.min(endAt, interval.endedAt ?? endAt),
    active: !interval.endKnown && interval.lastObservedAt <= endAt,
    ...interval.pid === undefined ? {} : { pid: interval.pid },
    ...interval.title === undefined ? {} : { title: interval.title }
  })).sort((left, right) => left.port - right.port || left.startAt - right.startAt));
}
function latestEvent(query, eventType, definitions, sourceInstanceId) {
  let latest;
  for (const event of query.events) {
    if (event.sourceInstanceId !== sourceInstanceId)
      continue;
    if (definitions.get(event.descriptorHash)?.descriptor.eventType !== eventType)
      continue;
    if (!latest || event.eventRecordSequence > latest.eventRecordSequence)
      latest = event;
  }
  return latest;
}
function sourceAuthority(activations, allowedSources) {
  const activationBySource = new Map((activations ?? []).map((activation) => [activation.sourceInstanceId, activation]));
  const replacementBySource = new Map;
  for (const activation of activations ?? []) {
    if (activation.replacesSourceInstanceId !== undefined)
      replacementBySource.set(activation.replacesSourceInstanceId, activation);
  }
  const sourceInstanceId = (activations ?? []).filter((activation) => allowedSources.has(activation.sourceInstanceId) && !replacementBySource.has(activation.sourceInstanceId)).sort((left, right) => right.activatedRecordSequence - left.activatedRecordSequence || right.sourceInstanceId.localeCompare(left.sourceInstanceId))[0]?.sourceInstanceId ?? (activations === undefined ? [...allowedSources].sort().at(-1) : undefined);
  const lineage = new Set;
  let cursor = sourceInstanceId;
  while (cursor !== undefined && !lineage.has(cursor)) {
    lineage.add(cursor);
    cursor = activationBySource.get(cursor)?.replacesSourceInstanceId;
  }
  return Object.freeze({ sourceInstanceId, lineage, activationBySource, replacementBySource });
}
function newestMachineSource(query, definitions) {
  const machineSources = new Set;
  let latest;
  for (const event of query.events) {
    const eventType = definitions.get(event.descriptorHash)?.descriptor.eventType;
    if (eventType !== "machine.cpu.utilization" && eventType !== "machine.memory.utilization" && eventType !== "machine.tcp.listeners")
      continue;
    machineSources.add(event.sourceInstanceId);
    if (!latest || event.eventRecordSequence > latest.eventRecordSequence)
      latest = event;
  }
  return sourceAuthority(query.sourceActivations, machineSources).sourceInstanceId ?? latest?.sourceInstanceId;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function scopeOf(...events) {
  for (const event of events) {
    if (typeof event?.attributes?.[0] === "string")
      return event.attributes[0];
  }
  return;
}
function projectMachineDashboard(query, now = Date.now()) {
  const definitions = new Map(query.definitions.map((definition) => [definition.hash, definition]));
  const sourceInstanceId = newestMachineSource(query, definitions);
  const cpu = latestEvent(query, "machine.cpu.utilization", definitions, sourceInstanceId);
  const memory = latestEvent(query, "machine.memory.utilization", definitions, sourceInstanceId);
  const ports = latestEvent(query, "machine.tcp.listeners", definitions, sourceInstanceId);
  const listenerPorts = typeof ports?.attributes?.[1] === "string" ? [...new Set(ports.attributes[1].split(",").map(Number).filter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535))].sort((left, right) => left - right) : [];
  const timestamps = [cpu, memory, ports].map((event) => event?.eventRecordTimestamp).filter((value) => value !== undefined);
  const lastObservedAt = timestamps.length > 0 ? Math.max(...timestamps) : undefined;
  return Object.freeze({
    sourceInstanceId,
    cpuPercent: finiteNumber(cpu?.measurement?.value),
    memoryPercent: finiteNumber(memory?.measurement?.value),
    totalBytes: finiteNumber(memory?.attributes?.[1]),
    availableBytes: finiteNumber(memory?.attributes?.[2]),
    listenerPorts: Object.freeze(listenerPorts),
    listenerPortsTruncated: ports?.attributes?.[2] === true,
    observationScope: scopeOf(ports, memory, cpu),
    latestRecordSequence: query.latestRecordSequence,
    lastObservedAt,
    freshnessMs: lastObservedAt === undefined ? undefined : Math.max(0, now - lastObservedAt)
  });
}
function projectMachineTimeline(query, endAt, windowMs) {
  const definitions = new Map(query.definitions.map((definition) => [definition.hash, definition]));
  const startAt = endAt - windowMs;
  const events = query.events.filter((event) => {
    const eventType = definitions.get(event.descriptorHash)?.descriptor.eventType;
    return eventType === "machine.cpu.utilization" || eventType === "machine.memory.utilization" || eventType === "machine.tcp.listeners";
  }).sort((left, right) => left.eventRecordSequence - right.eventRecordSequence);
  const authority = sourceAuthority(query.sourceActivations, new Set(events.map((event) => event.sourceInstanceId)));
  const cpu = [];
  const memory = [];
  for (const event of events) {
    const activation = authority.activationBySource.get(event.sourceInstanceId);
    const replacement = authority.replacementBySource.get(event.sourceInstanceId);
    if (!authority.lineage.has(event.sourceInstanceId) || activation !== undefined && event.eventRecordSequence < activation.activatedRecordSequence || replacement !== undefined && event.eventRecordSequence >= replacement.activatedRecordSequence || event.eventRecordTimestamp < startAt || event.eventRecordTimestamp > endAt)
      continue;
    const value = finiteNumber(event.measurement?.value);
    if (value === undefined)
      continue;
    const point = Object.freeze({ observedAt: event.eventRecordTimestamp, value });
    const eventType = definitions.get(event.descriptorHash)?.descriptor.eventType;
    if (eventType === "machine.cpu.utilization")
      cpu.push(point);
    else if (eventType === "machine.memory.utilization")
      memory.push(point);
  }
  return Object.freeze({
    sourceInstanceId: authority.sourceInstanceId,
    startAt,
    endAt,
    cpu: Object.freeze(cpu),
    memory: Object.freeze(memory)
  });
}
function projectMachineAggregate(result, endAt, windowMs) {
  const startAt = endAt - windowMs;
  const definitions = new Map((result?.definitions ?? []).map((definition) => [definition.hash, definition]));
  const inRange = (result?.buckets ?? []).filter((bucket) => bucket.startAt < endAt && bucket.endAt > startAt);
  const authority = sourceAuthority(result?.sourceActivations, new Set(inRange.map((bucket) => bucket.sourceInstanceId)));
  const sourceInstanceId = authority.sourceInstanceId;
  const cpu = [];
  const memory = [];
  for (const bucket of inRange) {
    if (!authority.lineage.has(bucket.sourceInstanceId))
      continue;
    const activation = authority.activationBySource.get(bucket.sourceInstanceId);
    const replacement = authority.replacementBySource.get(bucket.sourceInstanceId);
    const segmentStart = Math.max(startAt, bucket.startAt, activation?.activatedAt ?? Number.NEGATIVE_INFINITY);
    const segmentEnd = Math.min(endAt, bucket.endAt, replacement?.activatedAt ?? Number.POSITIVE_INFINITY);
    if (segmentStart >= segmentEnd)
      continue;
    const point = Object.freeze({ observedAt: segmentStart + (segmentEnd - segmentStart) / 2, value: bucket.mean, min: bucket.min, max: bucket.max, count: bucket.count });
    const eventType = definitions.get(bucket.descriptorHash)?.descriptor.eventType;
    if (eventType === "machine.cpu.utilization")
      cpu.push(point);
    else if (eventType === "machine.memory.utilization")
      memory.push(point);
  }
  cpu.sort((left, right) => left.observedAt - right.observedAt);
  memory.sort((left, right) => left.observedAt - right.observedAt);
  return Object.freeze({ sourceInstanceId, startAt, endAt, cpu: Object.freeze(cpu), memory: Object.freeze(memory), precisionMs: result?.bucketMs, partial: result?.partial ?? true });
}
function metric(value) {
  return value === undefined ? "—" : `${value.toFixed(1)}%`;
}
function bytes(value) {
  if (value === undefined)
    return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}
function formatDashboardStatus(projection, connectionError) {
  if (connectionError)
    return `Unavailable · ${connectionError}`;
  if (!projection.observationScope)
    return "Waiting for machine evidence…";
  return `${projection.freshnessMs !== undefined && projection.freshnessMs > 5000 ? "Stale" : "Live"} · ${projection.observationScope} scope`;
}
function drawMachineTimeline(canvas, timeline) {
  let context = null;
  try {
    context = canvas.getContext("2d");
  } catch {
    return;
  }
  if (!context)
    return;
  const width = canvas.width;
  const height = canvas.height;
  const left = 58;
  const right = 20;
  const top = 24;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#090d14";
  context.fillRect(0, 0, width, height);
  context.font = "18px Inter, system-ui, sans-serif";
  context.textBaseline = "middle";
  context.lineWidth = 1;
  for (const percent of [0, 25, 50, 75, 100]) {
    const y = top + plotHeight * (1 - percent / 100);
    context.strokeStyle = "#263044";
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(width - right, y);
    context.stroke();
    context.fillStyle = "#738099";
    context.textAlign = "right";
    context.fillText(`${percent}%`, left - 10, y);
  }
  const xFor = (observedAt) => left + (observedAt - timeline.startAt) / Math.max(1, timeline.endAt - timeline.startAt) * plotWidth;
  const yFor = (value) => top + plotHeight * (1 - Math.max(0, Math.min(100, value)) / 100);
  const drawSeries = (points, color) => {
    if (points.length === 0)
      return;
    if (points.some((point) => point.min !== undefined && point.max !== undefined)) {
      context.fillStyle = `${color}22`;
      context.beginPath();
      points.forEach((point, index) => {
        const x = xFor(point.observedAt);
        const y = yFor(point.max ?? point.value);
        if (index === 0)
          context.moveTo(x, y);
        else
          context.lineTo(x, y);
      });
      [...points].reverse().forEach((point) => context.lineTo(xFor(point.observedAt), yFor(point.min ?? point.value)));
      context.closePath();
      context.fill();
    }
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.beginPath();
    points.forEach((point, index) => {
      const x = xFor(point.observedAt);
      const y = yFor(point.value);
      if (index === 0)
        context.moveTo(x, y);
      else
        context.lineTo(x, y);
    });
    context.stroke();
  };
  drawSeries(timeline.memory, "#a78bfa");
  drawSeries(timeline.cpu, "#6ee7ff");
  context.fillStyle = "#738099";
  context.textAlign = "left";
  const formatTimestamp = (timestamp) => timeline.endAt - timeline.startAt >= 24 * 60 * 60000 ? new Date(timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : new Date(timestamp).toLocaleTimeString();
  context.fillText(formatTimestamp(timeline.startAt), left, height - 16);
  context.textAlign = "right";
  context.fillText(formatTimestamp(timeline.endAt), width - right, height - 16);
  if (timeline.cpu.length === 0 && timeline.memory.length === 0) {
    context.fillStyle = "#8f9bb0";
    context.textAlign = "center";
    context.fillText("Waiting for utilization history…", left + plotWidth / 2, top + plotHeight / 2);
  }
}
function renderPortTimeline(document, chart, count, axisStart, hover, history, endAt, windowMs, unavailable) {
  const startAt = endAt - windowMs;
  const intervals = projectPortTimeline(history, endAt, windowMs);
  const ports = [...new Set(intervals.map((interval) => interval.port))];
  const fragment = document.createDocumentFragment();
  for (const port of ports) {
    const row = document.createElement("div");
    row.className = "resource-monitor__port-row";
    const label = document.createElement("div");
    label.className = "resource-monitor__port-label";
    const portNumber = document.createElement("strong");
    portNumber.textContent = `:${port}`;
    label.append(portNumber);
    const named = intervals.find((interval) => interval.port === port && interval.active && interval.title) ?? [...intervals].reverse().find((interval) => interval.port === port && interval.title);
    if (named?.title) {
      const owner = document.createElement("small");
      owner.textContent = named.title;
      label.append(owner);
    }
    const track = document.createElement("div");
    track.className = "resource-monitor__port-track";
    for (const interval of intervals.filter((candidate) => candidate.port === port)) {
      const segment = document.createElement("span");
      segment.className = `resource-monitor__port-segment${interval.active ? " resource-monitor__port-segment--active" : ""}`;
      const left = Math.max(0, (interval.startAt - startAt) / windowMs * 100);
      const width = Math.max(0.4, (interval.endAt - interval.startAt) / windowMs * 100);
      segment.style.left = `${left}%`;
      segment.style.width = `${Math.min(100 - left, width)}%`;
      segment.tabIndex = 0;
      const owner = interval.title ? ` · ${interval.title}${interval.pid ? ` · PID ${interval.pid}` : ""}` : "";
      const description = `:${port}${owner} · ${interval.active ? "active" : "closed"} · ${Math.round((interval.endAt - interval.startAt) / 1000)}s`;
      segment.dataset.tooltip = description;
      segment.title = description;
      segment.setAttribute("aria-label", description);
      segment.addEventListener("mouseenter", () => {
        hover.textContent = description;
      });
      segment.addEventListener("focus", () => {
        hover.textContent = description;
      });
      track.append(segment);
    }
    row.append(label, track);
    fragment.append(row);
  }
  if (ports.length === 0) {
    const empty = document.createElement("p");
    empty.className = "resource-monitor__port-empty";
    empty.textContent = unavailable ? "Listener history unavailable." : "Waiting for listener history…";
    fragment.append(empty);
  }
  chart.replaceChildren(fragment);
  count.textContent = `${new Set(intervals.filter((interval) => interval.active).map((interval) => interval.port)).size} live`;
  axisStart.textContent = new Date(startAt).toLocaleTimeString();
}
function mountResourceMonitorDashboard(root, options) {
  const document = root.ownerDocument;
  root.replaceChildren();
  const shell = document.createElement("section");
  shell.className = "resource-monitor";
  const heading = document.createElement("header");
  const title = document.createElement("h1");
  title.textContent = "Resource Monitor";
  const status = document.createElement("p");
  status.dataset.status = "";
  status.textContent = "Connecting…";
  heading.append(title, status);
  const cards = document.createElement("div");
  cards.className = "resource-monitor__cards";
  const makeCard = (label, dataName) => {
    const article = document.createElement("article");
    const caption = document.createElement("span");
    caption.textContent = label;
    const value = document.createElement("strong");
    value.setAttribute(`data-${dataName}`, "");
    article.append(caption, value);
    cards.append(article);
    return value;
  };
  const cpu = makeCard("CPU", "cpu");
  const memory = makeCard("Memory", "memory");
  const ports = makeCard("TCP listeners", "ports");
  const timelinePanel = document.createElement("section");
  timelinePanel.className = "resource-monitor__timeline";
  const timelineHeader = document.createElement("div");
  timelineHeader.className = "resource-monitor__timeline-header";
  const timelineTitle = document.createElement("div");
  const timelineHeading = document.createElement("h2");
  timelineHeading.textContent = "Utilization timeline";
  const legend = document.createElement("p");
  legend.className = "resource-monitor__legend";
  legend.innerHTML = '<span data-series="cpu">CPU</span><span data-series="memory">Memory</span>';
  timelineTitle.append(timelineHeading, legend);
  const controls = document.createElement("div");
  controls.className = "resource-monitor__controls";
  const windows = [
    { label: "1m · raw", milliseconds: 60000, bucketMs: undefined },
    { label: "5m · raw", milliseconds: 300000, bucketMs: undefined },
    { label: "15m · raw", milliseconds: 900000, bucketMs: undefined },
    { label: "1h · 1m", milliseconds: 3600000, bucketMs: 60000 },
    { label: "6h · 1m", milliseconds: 21600000, bucketMs: 60000 },
    { label: "24h · 1m", milliseconds: 86400000, bucketMs: 60000 },
    { label: "7d · 15m", milliseconds: 604800000, bucketMs: 900000 },
    { label: "30d · 1h", milliseconds: 2592000000, bucketMs: 3600000 }
  ];
  let selectedWindowMs = windows[0].milliseconds;
  const range = document.createElement("select");
  range.setAttribute("aria-label", "Timeline range and precision");
  for (const { label, milliseconds } of windows) {
    const option = document.createElement("option");
    option.value = String(milliseconds);
    option.textContent = label;
    range.append(option);
  }
  controls.append(range);
  const pause = document.createElement("button");
  pause.type = "button";
  pause.dataset.pause = "";
  pause.textContent = "Pause";
  pause.setAttribute("aria-pressed", "false");
  controls.append(pause);
  timelineHeader.append(timelineTitle, controls);
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 360;
  canvas.setAttribute("aria-label", "CPU and memory utilization timeline");
  timelinePanel.append(timelineHeader, canvas);
  const portPanel = document.createElement("section");
  portPanel.className = "resource-monitor__ports";
  const portHeader = document.createElement("div");
  portHeader.className = "resource-monitor__ports-header";
  const portTitle = document.createElement("div");
  const portHeading = document.createElement("h2");
  portHeading.textContent = "Active ports";
  const portHelp = document.createElement("p");
  portHelp.textContent = "Lifetime bars stacked by port · hover or focus for details";
  portTitle.append(portHeading, portHelp);
  const activePortCount = document.createElement("strong");
  activePortCount.dataset.activePortCount = "";
  activePortCount.textContent = "0 live";
  portHeader.append(portTitle, activePortCount);
  const portChart = document.createElement("div");
  portChart.className = "resource-monitor__port-chart";
  portChart.setAttribute("role", "figure");
  portChart.setAttribute("aria-label", "TCP port lifetime timeline");
  const portAxis = document.createElement("div");
  portAxis.className = "resource-monitor__port-axis";
  const portAxisStart = document.createElement("span");
  const portAxisEnd = document.createElement("span");
  portAxisEnd.textContent = "now";
  portAxis.append(portAxisStart, portAxisEnd);
  const portHover = document.createElement("p");
  portHover.className = "resource-monitor__port-hover";
  portHover.setAttribute("aria-live", "polite");
  portHover.textContent = "Hover or focus a bar for port details.";
  portPanel.append(portHeader, portChart, portAxis, portHover);
  const details = document.createElement("p");
  details.className = "resource-monitor__details";
  shell.append(heading, cards, timelinePanel, portPanel, details);
  root.append(shell);
  const definitionByHash = new Map;
  const activationBySource = new Map;
  let events = [];
  let latestRecordSequence = 0;
  let connectionError;
  let stopped = false;
  let subscription;
  const now = options.now ?? Date.now;
  let pausedAt;
  let aggregateResult;
  let aggregateError;
  let aggregateRequest = 0;
  let listenerHistory;
  let listenerHistoryError;
  let listenerHistoryRequest = 0;
  const requestControllers = new Set;
  const inFlightRequests = new Set;
  let resolveStopped;
  const stoppedReady = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  let unmounting;
  const settleRequestsBounded = () => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    Promise.allSettled([...inFlightRequests]).then(finish);
  });
  const request = (start) => {
    const controller = new AbortController;
    requestControllers.add(controller);
    let pending;
    try {
      pending = Promise.resolve(start(controller.signal));
    } catch (error) {
      pending = Promise.reject(error);
    }
    inFlightRequests.add(pending);
    pending.then(() => {
      requestControllers.delete(controller);
      inFlightRequests.delete(pending);
    }, () => {
      requestControllers.delete(controller);
      inFlightRequests.delete(pending);
    });
    return pending;
  };
  const render = () => {
    const projection = projectMachineDashboard({
      definitions: [...definitionByHash.values()],
      events,
      openSpans: [],
      sourceActivations: [...activationBySource.values()],
      latestRecordSequence
    }, now());
    status.textContent = formatDashboardStatus(projection, connectionError);
    cpu.textContent = metric(projection.cpuPercent);
    memory.textContent = metric(projection.memoryPercent);
    ports.textContent = projection.listenerPorts.length === 0 ? "None observed" : `${projection.listenerPorts.join(", ")}${projection.listenerPortsTruncated ? " …" : ""}`;
    details.textContent = `Available ${bytes(projection.availableBytes)} of ${bytes(projection.totalBytes)} · record ${projection.latestRecordSequence}`;
    const endAt = pausedAt ?? now();
    const timeline = selectedWindowMs <= 900000 ? projectMachineTimeline({ definitions: [...definitionByHash.values()], events, openSpans: [], sourceActivations: [...activationBySource.values()], latestRecordSequence }, endAt, selectedWindowMs) : projectMachineAggregate(aggregateResult, endAt, selectedWindowMs);
    drawMachineTimeline(canvas, timeline);
    renderPortTimeline(document, portChart, activePortCount, portAxisStart, portHover, listenerHistory, endAt, selectedWindowMs, listenerHistoryError !== undefined);
    const selected = windows.find((candidate) => candidate.milliseconds === selectedWindowMs);
    legend.innerHTML = `<span data-series="cpu">CPU</span><span data-series="memory">Memory</span><span>${selected.bucketMs ? `${selected.bucketMs / 60000} min mean + min/max${timeline.partial ? " · partial history" : ""}${aggregateError ? " · aggregate unavailable" : ""}` : "raw samples"}</span>`;
  };
  const refreshAggregate = async () => {
    const selected = windows.find((candidate) => candidate.milliseconds === selectedWindowMs);
    if (!selected?.bucketMs) {
      aggregateResult = undefined;
      return;
    }
    const requestId = ++aggregateRequest;
    const endAt = pausedAt ?? now();
    try {
      const aggregateQuery = {
        bucketMs: selected.bucketMs,
        fromTimestamp: Math.max(0, endAt - selectedWindowMs),
        toTimestamp: endAt
      };
      const result = await request((signal) => options.client.aggregate(aggregateQuery, { signal }));
      if (!stopped && requestId === aggregateRequest) {
        aggregateResult = result;
        aggregateError = undefined;
        render();
      }
    } catch (error) {
      if (!stopped && requestId === aggregateRequest) {
        aggregateResult = undefined;
        aggregateError = error instanceof Error ? error.message : "aggregate history unavailable";
        render();
      }
    }
  };
  const refreshListenerHistory = async () => {
    const requestId = ++listenerHistoryRequest;
    const endAt = pausedAt ?? now();
    try {
      const listenerQuery = {
        fromTimestamp: Math.max(0, endAt - selectedWindowMs),
        toTimestamp: endAt
      };
      const result = await request((signal) => options.client.listenerHistory(listenerQuery, { signal }));
      if (!stopped && requestId === listenerHistoryRequest) {
        listenerHistory = result;
        listenerHistoryError = undefined;
        render();
      }
    } catch (error) {
      if (!stopped && requestId === listenerHistoryRequest) {
        listenerHistory = undefined;
        listenerHistoryError = error instanceof Error ? error.message : "listener history unavailable";
        render();
      }
    }
  };
  range.addEventListener("change", () => {
    selectedWindowMs = Number(range.value);
    refreshAggregate();
    refreshListenerHistory();
    render();
  });
  pause.addEventListener("click", () => {
    pausedAt = pausedAt === undefined ? now() : undefined;
    pause.textContent = pausedAt === undefined ? "Pause" : "Resume live";
    pause.setAttribute("aria-pressed", String(pausedAt !== undefined));
    refreshAggregate();
    refreshListenerHistory();
    render();
  });
  const mergeEvidence = (definitions, incomingEvents, sourceActivations, incomingLatestRecordSequence) => {
    if (stopped)
      return;
    for (const definition of definitions)
      definitionByHash.set(definition.hash, definition);
    for (const activation of sourceActivations)
      activationBySource.set(activation.sourceInstanceId, activation);
    const eventBySequence = new Map(events.map((event) => [event.eventRecordSequence, event]));
    for (const event of incomingEvents)
      eventBySequence.set(event.eventRecordSequence, event);
    events = [...eventBySequence.values()].sort((left, right) => left.eventRecordSequence - right.eventRecordSequence).slice(-5000);
    latestRecordSequence = Math.max(latestRecordSequence, incomingLatestRecordSequence);
    render();
  };
  const replace = (snapshot) => {
    mergeEvidence(snapshot.definitions, snapshot.events, snapshot.sourceActivations ?? [], snapshot.latestRecordSequence);
  };
  const append = (update) => {
    mergeEvidence(update.definitions, update.events, update.sourceActivations ?? [], update.latestRecordSequence);
  };
  const historyReady = (async () => {
    const cursor = await request((signal) => options.client.snapshot({ limit: 1 }, { signal }));
    if (stopped)
      return;
    let afterRecordSequence = Math.max(0, cursor.latestRecordSequence - 5000);
    for (let pageNumber = 0;pageNumber < 5 && afterRecordSequence < cursor.latestRecordSequence; pageNumber += 1) {
      const history = await request((signal) => options.client.snapshot({ afterRecordSequence, limit: 1000 }, { signal }));
      if (stopped)
        return;
      replace(history);
      const lastSequence = history.events.at(-1)?.eventRecordSequence;
      if (lastSequence === undefined || lastSequence <= afterRecordSequence)
        return;
      afterRecordSequence = lastSequence;
    }
  })().catch(() => {
    return;
  });
  try {
    subscription = options.client.subscribe({
      afterRecordSequence: 0,
      onSnapshot: replace,
      onAppend: append,
      onError(error) {
        if (!stopped) {
          connectionError = error.message;
          render();
        }
      }
    });
  } catch (error) {
    stopped = true;
    for (const controller of requestControllers)
      controller.abort();
    root.replaceChildren();
    resolveStopped();
    throw error;
  }
  const refresh = setInterval(render, 1000);
  const aggregateRefresh = setInterval(() => {
    refreshAggregate();
  }, 60000);
  const listenerHistoryRefresh = setInterval(() => {
    refreshListenerHistory();
  }, 1e4);
  const listenerHistoryReady = refreshListenerHistory();
  const initialReady = Promise.all([subscription.ready, historyReady, listenerHistoryReady]).then(() => {
    return;
  });
  const ready = Promise.race([
    initialReady.catch((error) => {
      if (!stopped)
        throw error;
    }),
    stoppedReady
  ]).then(() => {
    return;
  });
  return Object.freeze({
    ready,
    unmount() {
      if (unmounting)
        return unmounting;
      stopped = true;
      clearInterval(refresh);
      clearInterval(aggregateRefresh);
      clearInterval(listenerHistoryRefresh);
      for (const controller of requestControllers)
        controller.abort();
      subscription?.close();
      root.replaceChildren();
      resolveStopped();
      unmounting = settleRequestsBounded();
      return unmounting;
    }
  });
}

// packages/publish-sdk/src/gateway-ui.ts
async function requestJson(service, path, signal) {
  const response = await service.request(path, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Resource Monitor request failed with ${response.status}`);
  }
  return await response.json();
}
function mountedClient(service) {
  return Object.freeze({
    async ingest() {
      throw new Error("browser ingestion is unavailable");
    },
    snapshot(query = {}, options = {}) {
      const parameters = new URLSearchParams({
        after: String(query.afterRecordSequence ?? 0),
        limit: String(query.limit ?? 1000)
      });
      return requestJson(service, `/v1/observations?${parameters}`, options.signal);
    },
    aggregate(query, options = {}) {
      const parameters = new URLSearchParams({ from: String(query.fromTimestamp), to: String(query.toTimestamp), bucket: String(query.bucketMs) });
      if (query.sourceInstanceId !== undefined)
        parameters.set("source", query.sourceInstanceId);
      return requestJson(service, `/v1/observations/aggregates?${parameters}`, options.signal);
    },
    listenerHistory(query, options = {}) {
      const parameters = new URLSearchParams({ from: String(query.fromTimestamp), to: String(query.toTimestamp) });
      if (query.sourceInstanceId !== undefined)
        parameters.set("source", query.sourceInstanceId);
      return requestJson(service, `/v1/observations/listeners?${parameters}`, options.signal);
    },
    subscribe(options) {
      const controller = new AbortController;
      let cursor = options.afterRecordSequence ?? 0;
      let first = true;
      let resolveReady;
      let rejectReady;
      let settled = false;
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      (async () => {
        while (!controller.signal.aborted) {
          try {
            const snapshot = await requestJson(service, `/v1/observations?after=${cursor}&limit=1000`, controller.signal);
            if (first)
              options.onSnapshot(snapshot);
            else if (snapshot.events.length > 0 || (snapshot.sourceActivations?.length ?? 0) > 0) {
              const append = Object.freeze({
                definitions: snapshot.definitions,
                events: snapshot.events,
                ...snapshot.sourceActivations === undefined ? {} : { sourceActivations: snapshot.sourceActivations },
                latestRecordSequence: snapshot.latestRecordSequence
              });
              options.onAppend(append);
            }
            cursor = Math.max(cursor, snapshot.events.at(-1)?.eventRecordSequence ?? snapshot.latestRecordSequence);
            first = false;
            if (!settled) {
              settled = true;
              resolveReady();
            }
          } catch (error) {
            if (controller.signal.aborted)
              break;
            const failure = error instanceof Error ? error : new Error("Resource Monitor polling failed");
            options.onError?.(failure);
            if (!settled) {
              settled = true;
              rejectReady(failure);
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      })();
      return Object.freeze({ ready, close() {
        controller.abort();
      } });
    }
  });
}
function mount(host) {
  const service = host.services.api;
  if (!service)
    throw new Error("Resource Monitor API service is unavailable");
  const mounted = mountResourceMonitorDashboard(host.root, { client: mountedClient(service) });
  mounted.ready.catch(() => {
    return;
  });
  return () => {
    mounted.unmount();
  };
}
export {
  mount
};
