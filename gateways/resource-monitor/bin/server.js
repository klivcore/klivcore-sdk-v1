// @bun
// packages/publish-sdk/src/gateway-server.ts
import { randomBytes, timingSafeEqual } from "crypto";
import { chmod, mkdir, open, readFile, rename, writeFile } from "fs/promises";
import { resolve as resolve2 } from "path";

// packages/types/src/index.ts
var RESOURCE_MONITOR_PROTOCOL_VERSION = 1;

// packages/core/src/index.ts
var RESOURCE_MONITOR_COMMITTED = "committed";
function hasPartialAggregateCoverage(buckets, bucketMs, requestedFrom, requestedTo, expectedSeries) {
  if (expectedSeries.length === 0 || buckets.length === 0)
    return true;
  const groups = new Map;
  for (const bucket of buckets) {
    const key = `${bucket.sourceInstanceId}
${bucket.descriptorHash}`;
    const group = groups.get(key) ?? [];
    group.push(bucket);
    groups.set(key, group);
  }
  for (const expected of expectedSeries) {
    const expectedFrom = Math.floor(Math.max(requestedFrom, expected.expectedFrom ?? requestedFrom) / bucketMs) * bucketMs;
    const expectedTo = Math.ceil(Math.min(requestedTo, expected.expectedTo ?? requestedTo) / bucketMs) * bucketMs;
    if (expectedFrom >= expectedTo)
      continue;
    const group = groups.get(`${expected.sourceInstanceId}
${expected.descriptorHash}`);
    if (!group)
      return true;
    group.sort((left, right) => left.startAt - right.startAt);
    if (group[0].startAt > expectedFrom || group.at(-1).endAt < expectedTo)
      return true;
    for (let index = 1;index < group.length; index += 1) {
      if (group[index].startAt > group[index - 1].endAt)
        return true;
    }
  }
  return false;
}
var HASH = /^[a-f0-9]{32}$/;
var ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var CATEGORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;
var SENSITIVE_ATTRIBUTE_NAME = /(secret|credential|password|passphrase|apikey|accesstoken|authtoken|connectionstring|prompt|tooloutput|providerpayload)/;
var CREDENTIAL_VALUE = /(?:\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|pk|rk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{8,}|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@)/i;
var MAX_TEXT = 256;
var MAX_ATTRIBUTES = 32;
var MAX_BATCH_EVENTS = 4096;
var MAX_BATCH_DEFINITIONS = 256;
function boundedText(value, label, max = MAX_TEXT) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError(`${label} must be bounded text`);
  }
  return value;
}
function identifier(value, label) {
  const parsed = boundedText(value, label, 128);
  if (!ID.test(parsed))
    throw new TypeError(`${label} is invalid`);
  return parsed;
}
function categoryIdentifier(value, label) {
  const parsed = boundedText(value, label, 128);
  if (!CATEGORY_ID.test(parsed))
    throw new TypeError(`${label} is invalid`);
  return parsed;
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`${label} must be finite`);
  return value;
}
function safePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}
function safeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}
function canonicalDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("descriptor must be an object");
  if (input.schemaVersion !== 1)
    throw new TypeError("descriptor schemaVersion must be 1");
  const attributes = input.attributes?.map((attribute, index) => {
    if (!attribute || typeof attribute !== "object" || Array.isArray(attribute))
      throw new TypeError(`descriptor attribute ${index} is invalid`);
    if (!["string", "number", "boolean", "null"].includes(attribute.type))
      throw new TypeError(`descriptor attribute ${index} type is invalid`);
    const name = identifier(attribute.name, `descriptor attribute ${index} name`);
    if (SENSITIVE_ATTRIBUTE_NAME.test(name.toLowerCase().replace(/[^a-z]/g, "")))
      throw new TypeError(`descriptor attribute ${index} is a sensitive attribute`);
    return Object.freeze({ name, type: attribute.type });
  });
  if ((attributes?.length ?? 0) > MAX_ATTRIBUTES)
    throw new TypeError("descriptor has too many attributes");
  if (attributes && new Set(attributes.map((attribute) => attribute.name)).size !== attributes.length)
    throw new TypeError("descriptor has duplicate attributes");
  const measurement = input.measurement === undefined ? undefined : Object.freeze({
    name: identifier(input.measurement.name, "descriptor measurement name"),
    ...input.measurement.unit === undefined ? {} : { unit: boundedText(input.measurement.unit, "descriptor measurement unit", 64) }
  });
  return Object.freeze({
    schemaVersion: 1,
    sourceId: identifier(input.sourceId, "descriptor sourceId"),
    ...input.categoryId === undefined ? {} : { categoryId: categoryIdentifier(input.categoryId, "descriptor categoryId") },
    eventType: identifier(input.eventType, "descriptor eventType"),
    ...measurement === undefined ? {} : { measurement },
    ...attributes === undefined ? {} : { attributes: Object.freeze(attributes) }
  });
}
function descriptorBytes(descriptor) {
  const attributes = descriptor.attributes?.map(({ name, type }) => [name, type]) ?? null;
  const measurement = descriptor.measurement ? [descriptor.measurement.name, descriptor.measurement.unit ?? null] : null;
  return new TextEncoder().encode(JSON.stringify([
    descriptor.schemaVersion,
    descriptor.sourceId,
    descriptor.categoryId ?? null,
    descriptor.eventType,
    measurement,
    attributes
  ]));
}
function fnv32(bytes, seed) {
  let hash = seed >>> 0;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}
function descriptorHash(descriptor) {
  const bytes = descriptorBytes(descriptor);
  return [2166136261, 2654435761, 2246822519, 3266489917].map((seed) => fnv32(bytes, seed).toString(16).padStart(8, "0")).join("");
}
function createEventDescriptor(input) {
  const descriptor = canonicalDescriptor(input);
  return Object.freeze({ hash: descriptorHash(descriptor), descriptor });
}
function phaseCode(phase) {
  return phase === undefined ? 0 : phase === "start" ? 1 : phase === "update" ? 2 : 3;
}
function validateEvent(event, descriptor, sourceInstanceId) {
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new TypeError("event must be an object");
  if (!HASH.test(event.descriptorHash))
    throw new TypeError("event descriptorHash is invalid");
  const sourceSequence = safePositiveInteger(event.sourceSequence, "event sourceSequence");
  const eventTimestamp = finite(event.eventTimestamp, "event eventTimestamp");
  const eventMonotonicTimestamp = event.eventMonotonicTimestamp === undefined ? undefined : finite(event.eventMonotonicTimestamp, "event eventMonotonicTimestamp");
  let span;
  if (event.span !== undefined) {
    if (!event.span || typeof event.span !== "object" || Array.isArray(event.span) || !["start", "update", "end"].includes(event.span.phase))
      throw new TypeError("event span is invalid");
    span = Object.freeze({
      spanId: identifier(event.span.spanId, "event spanId"),
      phase: event.span.phase,
      ...event.span.parentSpanId === undefined ? {} : { parentSpanId: identifier(event.span.parentSpanId, "event parentSpanId") }
    });
  }
  let measurement;
  if (event.measurement !== undefined) {
    if (!descriptor.measurement)
      throw new TypeError("event measurement is not declared by descriptor");
    const value = finite(event.measurement.value, "event measurement value");
    const min = event.measurement.min === undefined ? undefined : finite(event.measurement.min, "event measurement min");
    const max = event.measurement.max === undefined ? undefined : finite(event.measurement.max, "event measurement max");
    if (min !== undefined && max !== undefined && min > max)
      throw new TypeError("event measurement min exceeds max");
    if (min !== undefined && value < min || max !== undefined && value > max)
      throw new TypeError("event measurement value is outside range");
    measurement = Object.freeze({ value, ...min === undefined ? {} : { min }, ...max === undefined ? {} : { max } });
  }
  const attributes = event.attributes === undefined ? undefined : [...event.attributes];
  if (attributes !== undefined) {
    if (attributes.length !== (descriptor.attributes?.length ?? 0))
      throw new TypeError("event attributes do not match descriptor");
    descriptor.attributes?.forEach((attribute, index) => {
      const value = attributes[index];
      if (attribute.type === "null" ? value !== null : typeof value !== attribute.type)
        throw new TypeError(`event attribute ${index} has invalid type`);
      if (typeof value === "string") {
        boundedText(value, `event attribute ${index}`, 512);
        if (CREDENTIAL_VALUE.test(value))
          attributes[index] = "[REDACTED]";
      }
      if (typeof value === "number")
        finite(value, `event attribute ${index}`);
    });
  }
  return Object.freeze({
    descriptorHash: event.descriptorHash,
    sourceSequence,
    eventTimestamp,
    ...eventMonotonicTimestamp === undefined ? {} : { eventMonotonicTimestamp },
    ...span === undefined ? {} : { span },
    ...measurement === undefined ? {} : { measurement },
    ...attributes === undefined ? {} : { attributes: Object.freeze(attributes) }
  });
}
function createResourceMonitor(options) {
  const maxEvents = safePositiveInteger(options.maxEvents, "maxEvents");
  const maxAggregateBuckets = safePositiveInteger(options.maxAggregateBuckets ?? 20000, "maxAggregateBuckets");
  const maxDescriptors = safePositiveInteger(options.maxDescriptors ?? 4096, "maxDescriptors");
  const maxSources = safePositiveInteger(options.maxSources ?? 4096, "maxSources");
  const maxOpenSpans = safePositiveInteger(options.maxOpenSpans ?? 4096, "maxOpenSpans");
  const now = options.now ?? Date.now;
  let descriptors = new Map;
  let latestSourceSequences = new Map;
  let sourceActivations = new Map;
  let replacementsBySource = new Map;
  const retainedSourceInstanceIds = new Array(maxEvents);
  const retainedDescriptorHashes = new Array(maxEvents);
  const retainedSourceSequences = new Float64Array(maxEvents);
  const retainedEventTimestamps = new Float64Array(maxEvents);
  const retainedMonotonicTimestamps = new Float64Array(maxEvents).fill(Number.NaN);
  const retainedRecordTimestamps = new Float64Array(maxEvents);
  const retainedRecordSequences = new Float64Array(maxEvents);
  const retainedSpanIds = new Array(maxEvents);
  const retainedSpanPhases = new Uint8Array(maxEvents);
  const retainedParentSpanIds = new Array(maxEvents);
  const retainedMeasurementValues = new Float64Array(maxEvents).fill(Number.NaN);
  const retainedMeasurementMinimums = new Float64Array(maxEvents).fill(Number.NaN);
  const retainedMeasurementMaximums = new Float64Array(maxEvents).fill(Number.NaN);
  const retainedAttributes = new Array(maxEvents);
  let retainedStart = 0;
  let retainedCount = 0;
  let openSpans = new Map;
  const listeners = new Set;
  let aggregateBuckets = new Map;
  let recordSequence = 0;
  let acceptedEvents = 0;
  let duplicateEvents = 0;
  let sequenceGaps = 0;
  if (options.recovered) {
    const recovered = options.recovered;
    if (recovered.definitions.length > maxDescriptors || recovered.sourceHeads.length > maxSources || recovered.events.length > maxEvents || recovered.openSpans.length > maxOpenSpans) {
      throw new RangeError("resource monitor recovered state exceeds configured bounds");
    }
    for (const definition of recovered.definitions) {
      const canonical = createEventDescriptor(definition.descriptor);
      if (canonical.hash !== definition.hash || descriptors.has(definition.hash))
        throw new TypeError("resource monitor recovered descriptor is invalid");
      descriptors.set(definition.hash, canonical);
    }
    for (const head of recovered.sourceHeads) {
      const sourceInstanceId = identifier(head.sourceInstanceId, "recovered sourceInstanceId");
      const latestSourceSequence = safePositiveInteger(head.latestSourceSequence, "recovered latestSourceSequence");
      if (latestSourceSequences.has(sourceInstanceId))
        throw new TypeError("resource monitor recovered source is duplicated");
      latestSourceSequences.set(sourceInstanceId, latestSourceSequence);
      if (head.activatedAt !== undefined || head.activatedRecordSequence !== undefined || head.replacesSourceInstanceId !== undefined) {
        if (head.activatedAt === undefined || head.activatedRecordSequence === undefined)
          throw new TypeError("resource monitor recovered activation is incomplete");
        const replacesSourceInstanceId = head.replacesSourceInstanceId === undefined ? undefined : identifier(head.replacesSourceInstanceId, "recovered replacesSourceInstanceId");
        const activation = Object.freeze({
          sourceInstanceId,
          ...replacesSourceInstanceId === undefined ? {} : { replacesSourceInstanceId },
          activatedAt: finite(head.activatedAt, "recovered activatedAt"),
          activatedRecordSequence: safePositiveInteger(head.activatedRecordSequence, "recovered activatedRecordSequence")
        });
        sourceActivations.set(sourceInstanceId, activation);
        if (replacesSourceInstanceId !== undefined) {
          if (replacesSourceInstanceId === sourceInstanceId || replacementsBySource.has(replacesSourceInstanceId))
            throw new TypeError("resource monitor recovered replacement is invalid");
          replacementsBySource.set(replacesSourceInstanceId, sourceInstanceId);
        }
      }
    }
    recordSequence = safeNonNegativeInteger(recovered.latestRecordSequence, "recovered latestRecordSequence");
    acceptedEvents = recordSequence;
    duplicateEvents = safeNonNegativeInteger(recovered.duplicateEvents, "recovered duplicateEvents");
    sequenceGaps = safeNonNegativeInteger(recovered.sequenceGaps, "recovered sequenceGaps");
    let previousRecordSequence = 0;
    for (const event of recovered.events) {
      if (!descriptors.has(event.descriptorHash) || !latestSourceSequences.has(event.sourceInstanceId) || !Number.isSafeInteger(event.eventRecordSequence) || event.eventRecordSequence <= previousRecordSequence || event.eventRecordSequence > recordSequence) {
        throw new TypeError("resource monitor recovered event is invalid");
      }
      previousRecordSequence = event.eventRecordSequence;
      const index = retainedCount;
      retainedSourceInstanceIds[index] = event.sourceInstanceId;
      retainedDescriptorHashes[index] = event.descriptorHash;
      retainedSourceSequences[index] = event.sourceSequence;
      retainedEventTimestamps[index] = event.eventTimestamp;
      retainedMonotonicTimestamps[index] = event.eventMonotonicTimestamp ?? Number.NaN;
      retainedRecordTimestamps[index] = event.eventRecordTimestamp;
      retainedRecordSequences[index] = event.eventRecordSequence;
      retainedSpanIds[index] = event.span?.spanId;
      retainedSpanPhases[index] = phaseCode(event.span?.phase);
      retainedParentSpanIds[index] = event.span?.parentSpanId;
      retainedMeasurementValues[index] = event.measurement?.value ?? Number.NaN;
      retainedMeasurementMinimums[index] = event.measurement?.min ?? Number.NaN;
      retainedMeasurementMaximums[index] = event.measurement?.max ?? Number.NaN;
      retainedAttributes[index] = event.attributes;
      retainedCount += 1;
      if (!sourceActivations.has(event.sourceInstanceId)) {
        sourceActivations.set(event.sourceInstanceId, Object.freeze({
          sourceInstanceId: event.sourceInstanceId,
          activatedAt: event.eventRecordTimestamp,
          activatedRecordSequence: event.eventRecordSequence
        }));
      }
    }
    for (const span of recovered.openSpans) {
      const sourceInstanceId = identifier(span.sourceInstanceId, "recovered span sourceInstanceId");
      const spanId = identifier(span.spanId, "recovered spanId");
      if (!descriptors.has(span.descriptorHash) || !latestSourceSequences.has(sourceInstanceId))
        throw new TypeError("resource monitor recovered span is invalid");
      const key = `${sourceInstanceId}
${spanId}`;
      if (openSpans.has(key))
        throw new TypeError("resource monitor recovered span is duplicated");
      openSpans.set(key, Object.freeze({
        descriptorHash: span.descriptorHash,
        sourceInstanceId,
        spanId,
        startedAt: finite(span.startedAt, "recovered span startedAt"),
        updatedAt: finite(span.updatedAt, "recovered span updatedAt")
      }));
    }
  }
  const ingest = (batch) => {
    if (!batch || typeof batch !== "object" || Array.isArray(batch) || batch.protocolVersion !== RESOURCE_MONITOR_PROTOCOL_VERSION)
      throw new TypeError("incompatible resource monitor batch");
    const sourceInstanceId = identifier(batch.sourceInstanceId, "batch sourceInstanceId");
    const replacesSourceInstanceId = batch.replacesSourceInstanceId === undefined ? undefined : identifier(batch.replacesSourceInstanceId, "batch replacesSourceInstanceId");
    if (replacesSourceInstanceId === sourceInstanceId)
      throw new TypeError("source cannot replace itself");
    if (!Array.isArray(batch.definitions) || batch.definitions.length > MAX_BATCH_DEFINITIONS)
      throw new TypeError("batch definitions are invalid");
    if (!Array.isArray(batch.events) || batch.events.length > MAX_BATCH_EVENTS)
      throw new TypeError("batch events are invalid");
    if (batch.events.length > 0 && !latestSourceSequences.has(sourceInstanceId) && latestSourceSequences.size >= maxSources) {
      throw new RangeError("resource monitor source limit reached");
    }
    const stagedDescriptors = new Map;
    for (const definition of batch.definitions) {
      if (!definition || typeof definition !== "object" || !HASH.test(definition.hash))
        throw new TypeError("descriptor definition is invalid");
      const canonical = createEventDescriptor(definition.descriptor);
      if (canonical.hash !== definition.hash)
        throw new TypeError("descriptor hash mismatch");
      const existing = stagedDescriptors.get(definition.hash) ?? descriptors.get(definition.hash);
      if (existing && JSON.stringify(existing.descriptor) !== JSON.stringify(canonical.descriptor))
        throw new TypeError("descriptor hash collision");
      if (!existing) {
        if (descriptors.size + stagedDescriptors.size >= maxDescriptors)
          throw new RangeError("resource monitor descriptor limit reached");
        stagedDescriptors.set(definition.hash, canonical);
      }
    }
    const accepted = [];
    const gaps = [];
    const spanChanges = new Map;
    let projectedOpenSpans = openSpans.size;
    let batchRecordTimestamp;
    let duplicates = 0;
    let latest = latestSourceSequences.get(sourceInstanceId) ?? 0;
    const existingActivation = sourceActivations.get(sourceInstanceId);
    if (existingActivation && existingActivation.replacesSourceInstanceId !== replacesSourceInstanceId) {
      throw new TypeError("source replacement lineage does not match its activation");
    }
    if (!existingActivation && replacesSourceInstanceId !== undefined) {
      if (!latestSourceSequences.has(replacesSourceInstanceId))
        throw new TypeError("replacement source is unknown");
      const existingReplacement = replacementsBySource.get(replacesSourceInstanceId);
      if (existingReplacement !== undefined && existingReplacement !== sourceInstanceId)
        throw new TypeError("source was already replaced");
    }
    for (const candidate of batch.events) {
      safePositiveInteger(candidate.sourceSequence, "event sourceSequence");
      const definition = stagedDescriptors.get(candidate.descriptorHash) ?? descriptors.get(candidate.descriptorHash);
      if (!definition)
        throw new TypeError("event references an unknown descriptor");
      const event = validateEvent(candidate, definition.descriptor, sourceInstanceId);
      if (event.sourceSequence <= latest) {
        duplicates += 1;
        continue;
      }
      if (replacementsBySource.has(sourceInstanceId))
        throw new TypeError("replaced source cannot publish new events");
      if (candidate.sourceSequence > latest + 1) {
        const gap = Object.freeze({ sourceInstanceId, from: latest + 1, to: candidate.sourceSequence - 1 });
        gaps.push(gap);
      }
      latest = event.sourceSequence;
      const recorded = Object.freeze({
        ...event,
        sourceInstanceId,
        eventRecordTimestamp: batchRecordTimestamp ??= finite(now(), "eventRecordTimestamp"),
        eventRecordSequence: recordSequence + accepted.length + 1
      });
      accepted.push(recorded);
      if (event.span) {
        const key = `${sourceInstanceId}
${event.span.spanId}`;
        const previous = spanChanges.has(key) ? spanChanges.get(key) : openSpans.get(key);
        if (event.span.phase === "end") {
          if (previous)
            projectedOpenSpans -= 1;
          spanChanges.set(key, null);
        } else if (previous)
          spanChanges.set(key, Object.freeze({ ...previous, descriptorHash: event.descriptorHash, updatedAt: event.eventTimestamp }));
        else {
          projectedOpenSpans += 1;
          if (projectedOpenSpans > maxOpenSpans)
            throw new RangeError("resource monitor open span limit reached");
          spanChanges.set(key, Object.freeze({ descriptorHash: event.descriptorHash, sourceInstanceId, spanId: event.span.spanId, startedAt: event.eventTimestamp, updatedAt: event.eventTimestamp }));
        }
      }
    }
    const nextDescriptors = new Map(descriptors);
    for (const [hash, definition] of stagedDescriptors)
      nextDescriptors.set(hash, definition);
    const nextOpenSpans = new Map(openSpans);
    const preparedSpanChanges = [];
    for (const [key, span] of spanChanges) {
      if (span)
        nextOpenSpans.set(key, span);
      else
        nextOpenSpans.delete(key);
      const separator = key.indexOf(`
`);
      preparedSpanChanges.push(Object.freeze({
        sourceInstanceId: key.slice(0, separator),
        spanId: key.slice(separator + 1),
        span
      }));
    }
    const nextLatestSourceSequences = new Map(latestSourceSequences);
    if (batch.events.length > 0)
      nextLatestSourceSequences.set(sourceInstanceId, latest);
    const sourceActivation = existingActivation ?? (accepted.length === 0 ? undefined : Object.freeze({
      sourceInstanceId,
      ...replacesSourceInstanceId === undefined ? {} : { replacesSourceInstanceId },
      activatedAt: accepted[0].eventRecordTimestamp,
      activatedRecordSequence: accepted[0].eventRecordSequence
    }));
    const nextSourceActivations = new Map(sourceActivations);
    const nextReplacementsBySource = new Map(replacementsBySource);
    if (!existingActivation && sourceActivation !== undefined) {
      nextSourceActivations.set(sourceInstanceId, sourceActivation);
      if (replacesSourceInstanceId !== undefined)
        nextReplacementsBySource.set(replacesSourceInstanceId, sourceInstanceId);
    }
    const nextRecordSequence = recordSequence + accepted.length;
    const nextAcceptedEvents = acceptedEvents + accepted.length;
    const nextDuplicateEvents = duplicateEvents + duplicates;
    const nextSequenceGaps = sequenceGaps + gaps.length;
    const nextAggregateBuckets = new Map(aggregateBuckets);
    for (const event of accepted) {
      const definition = nextDescriptors.get(event.descriptorHash);
      const eventType = definition?.descriptor.eventType;
      const value = event.measurement?.value;
      if ((eventType === "machine.cpu.utilization" || eventType === "machine.memory.utilization") && value !== undefined) {
        for (const bucketMs of [60000, 900000, 3600000, 21600000]) {
          const startAt = Math.floor(event.eventRecordTimestamp / bucketMs) * bucketMs;
          const key = `${bucketMs}
${event.sourceInstanceId}
${event.descriptorHash}
${startAt}`;
          const previous = nextAggregateBuckets.get(key);
          const count = (previous?.count ?? 0) + 1;
          nextAggregateBuckets.set(key, Object.freeze({
            descriptorHash: event.descriptorHash,
            sourceInstanceId: event.sourceInstanceId,
            startAt,
            endAt: startAt + bucketMs,
            count,
            min: previous === undefined ? value : Math.min(previous.min, value),
            max: previous === undefined ? value : Math.max(previous.max, value),
            mean: previous === undefined ? value : (previous.mean * previous.count + value) / count,
            first: previous?.first ?? value,
            last: value
          }));
          while (nextAggregateBuckets.size > maxAggregateBuckets)
            nextAggregateBuckets.delete(nextAggregateBuckets.keys().next().value);
        }
      }
    }
    const result = Object.freeze({
      accepted: accepted.length,
      duplicates,
      gaps: Object.freeze(gaps),
      ...accepted.length === 0 ? {} : { firstRecordSequence: accepted[0].eventRecordSequence, lastRecordSequence: accepted.at(-1).eventRecordSequence }
    });
    const append = accepted.length === 0 ? undefined : Object.freeze({
      definitions: Object.freeze([...new Set(accepted.map((event) => event.descriptorHash))].map((hash) => nextDescriptors.get(hash)).filter(Boolean)),
      events: Object.freeze([...accepted]),
      sourceActivations: Object.freeze(sourceActivation === undefined || existingActivation ? [] : [sourceActivation]),
      latestRecordSequence: nextRecordSequence
    });
    const prepared = Object.freeze({
      sourceInstanceId,
      definitions: Object.freeze([...stagedDescriptors.values()]),
      events: Object.freeze([...accepted]),
      spanChanges: Object.freeze(preparedSpanChanges),
      ...batch.events.length === 0 ? {} : { latestSourceSequence: latest },
      ...sourceActivation === undefined || existingActivation ? {} : { sourceActivation },
      nextStats: Object.freeze({
        acceptedEvents: nextAcceptedEvents,
        duplicateEvents: nextDuplicateEvents,
        descriptorCount: nextDescriptors.size,
        sourceCount: nextLatestSourceSequences.size,
        retainedEvents: Math.min(maxEvents, retainedCount + accepted.length),
        openSpans: nextOpenSpans.size,
        sequenceGaps: nextSequenceGaps
      }),
      result,
      ...append === undefined ? {} : { append }
    });
    if (options.commit && options.commit(prepared) !== RESOURCE_MONITOR_COMMITTED) {
      throw new Error("resource monitor persistence did not commit synchronously");
    }
    descriptors = nextDescriptors;
    openSpans = nextOpenSpans;
    latestSourceSequences = nextLatestSourceSequences;
    sourceActivations = nextSourceActivations;
    replacementsBySource = nextReplacementsBySource;
    aggregateBuckets = nextAggregateBuckets;
    recordSequence = nextRecordSequence;
    acceptedEvents = nextAcceptedEvents;
    duplicateEvents = nextDuplicateEvents;
    sequenceGaps = nextSequenceGaps;
    for (const event of accepted) {
      const index = retainedCount < maxEvents ? (retainedStart + retainedCount) % maxEvents : retainedStart;
      retainedSourceInstanceIds[index] = event.sourceInstanceId;
      retainedDescriptorHashes[index] = event.descriptorHash;
      retainedSourceSequences[index] = event.sourceSequence;
      retainedEventTimestamps[index] = event.eventTimestamp;
      retainedMonotonicTimestamps[index] = event.eventMonotonicTimestamp ?? Number.NaN;
      retainedRecordTimestamps[index] = event.eventRecordTimestamp;
      retainedRecordSequences[index] = event.eventRecordSequence;
      retainedSpanIds[index] = event.span?.spanId;
      retainedSpanPhases[index] = phaseCode(event.span?.phase);
      retainedParentSpanIds[index] = event.span?.parentSpanId;
      retainedMeasurementValues[index] = event.measurement?.value ?? Number.NaN;
      retainedMeasurementMinimums[index] = event.measurement?.min ?? Number.NaN;
      retainedMeasurementMaximums[index] = event.measurement?.max ?? Number.NaN;
      retainedAttributes[index] = event.attributes;
      if (retainedCount < maxEvents)
        retainedCount += 1;
      else
        retainedStart = (retainedStart + 1) % maxEvents;
    }
    if (append && listeners.size > 0) {
      for (const listener of listeners) {
        try {
          listener(append);
        } catch {}
      }
    }
    return result;
  };
  return Object.freeze({
    ingest,
    aggregate(query) {
      const bucketMs = query.bucketMs;
      if (bucketMs !== 60000 && bucketMs !== 900000 && bucketMs !== 3600000 && bucketMs !== 21600000) {
        throw new TypeError("resource monitor aggregate bucket precision is invalid");
      }
      const requestedFrom = finite(query.fromTimestamp, "aggregate fromTimestamp");
      const requestedTo = finite(query.toTimestamp, "aggregate toTimestamp");
      if (requestedFrom < 0 || requestedTo <= requestedFrom || Math.ceil((requestedTo - requestedFrom) / bucketMs) > 3000) {
        throw new RangeError("resource monitor aggregate range is invalid");
      }
      const buckets = [...aggregateBuckets.values()].filter((bucket) => bucket.endAt - bucket.startAt === bucketMs && bucket.startAt < requestedTo && bucket.endAt > requestedFrom && (query.sourceInstanceId === undefined || bucket.sourceInstanceId === query.sourceInstanceId)).sort((left, right) => left.startAt - right.startAt || left.sourceInstanceId.localeCompare(right.sourceInstanceId) || left.descriptorHash.localeCompare(right.descriptorHash));
      const actualFrom = buckets.length === 0 ? undefined : Math.min(...buckets.map((bucket) => bucket.startAt));
      const actualTo = buckets.length === 0 ? undefined : Math.max(...buckets.map((bucket) => bucket.endAt));
      const used = new Set(buckets.map((bucket) => bucket.descriptorHash));
      const expectedSeries = [...new Map([...aggregateBuckets.values()].filter((bucket) => bucket.endAt - bucket.startAt === bucketMs && (query.sourceInstanceId === undefined || bucket.sourceInstanceId === query.sourceInstanceId)).map((bucket) => {
        const activation = sourceActivations.get(bucket.sourceInstanceId);
        const replacementId = replacementsBySource.get(bucket.sourceInstanceId);
        const replacement = replacementId === undefined ? undefined : sourceActivations.get(replacementId);
        return [`${bucket.sourceInstanceId}
${bucket.descriptorHash}`, {
          sourceInstanceId: bucket.sourceInstanceId,
          descriptorHash: bucket.descriptorHash,
          ...activation === undefined ? {} : { expectedFrom: activation.activatedAt },
          ...replacement === undefined ? {} : { expectedTo: replacement.activatedAt }
        }];
      })).values()];
      return Object.freeze({
        bucketMs,
        requestedFrom,
        requestedTo,
        ...actualFrom === undefined ? {} : { actualFrom, actualTo },
        partial: hasPartialAggregateCoverage(buckets, bucketMs, requestedFrom, requestedTo, expectedSeries),
        definitions: Object.freeze([...used].map((hash) => descriptors.get(hash)).filter(Boolean)),
        buckets: Object.freeze(buckets),
        sourceActivations: Object.freeze([...sourceActivations.values()].sort((left, right) => left.activatedRecordSequence - right.activatedRecordSequence))
      });
    },
    query(query) {
      const limit = safePositiveInteger(query.limit, "query limit");
      if (limit > 1e4)
        throw new RangeError("query limit exceeds 10000");
      const after = query.afterRecordSequence ?? 0;
      const events = [];
      for (let index = 0;index < retainedCount && events.length < limit; index += 1) {
        const retainedIndex = (retainedStart + index) % maxEvents;
        const eventRecordSequence = retainedRecordSequences[retainedIndex];
        const eventTimestamp = retainedEventTimestamps[retainedIndex];
        if (eventRecordSequence <= after || query.fromEventTimestamp !== undefined && eventTimestamp < query.fromEventTimestamp || query.toEventTimestamp !== undefined && eventTimestamp > query.toEventTimestamp)
          continue;
        const monotonicTimestamp = retainedMonotonicTimestamps[retainedIndex];
        const spanId = retainedSpanIds[retainedIndex];
        const phase = [undefined, "start", "update", "end"][retainedSpanPhases[retainedIndex]];
        const measurementValue = retainedMeasurementValues[retainedIndex];
        const measurementMin = retainedMeasurementMinimums[retainedIndex];
        const measurementMax = retainedMeasurementMaximums[retainedIndex];
        const attributes = retainedAttributes[retainedIndex];
        events.push(Object.freeze({
          descriptorHash: retainedDescriptorHashes[retainedIndex],
          sourceInstanceId: retainedSourceInstanceIds[retainedIndex],
          sourceSequence: retainedSourceSequences[retainedIndex],
          eventTimestamp,
          eventRecordTimestamp: retainedRecordTimestamps[retainedIndex],
          eventRecordSequence,
          ...Number.isNaN(monotonicTimestamp) ? {} : { eventMonotonicTimestamp: monotonicTimestamp },
          ...spanId === undefined || phase === undefined ? {} : { span: Object.freeze({
            spanId,
            phase,
            ...retainedParentSpanIds[retainedIndex] === undefined ? {} : { parentSpanId: retainedParentSpanIds[retainedIndex] }
          }) },
          ...Number.isNaN(measurementValue) ? {} : { measurement: Object.freeze({
            value: measurementValue,
            ...Number.isNaN(measurementMin) ? {} : { min: measurementMin },
            ...Number.isNaN(measurementMax) ? {} : { max: measurementMax }
          }) },
          ...attributes === undefined ? {} : { attributes }
        }));
      }
      const used = new Set(events.map((event) => event.descriptorHash));
      return Object.freeze({
        definitions: Object.freeze([...used].map((hash) => descriptors.get(hash)).filter(Boolean)),
        events: Object.freeze(events),
        openSpans: Object.freeze([...openSpans.values()]),
        sourceActivations: Object.freeze([...sourceActivations.values()].sort((left, right) => left.activatedRecordSequence - right.activatedRecordSequence)),
        latestRecordSequence: recordSequence
      });
    },
    stats: () => Object.freeze({ acceptedEvents, duplicateEvents, descriptorCount: descriptors.size, sourceCount: latestSourceSequences.size, retainedEvents: retainedCount, openSpans: openSpans.size, sequenceGaps }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}

// packages/server/src/index.ts
var RESOURCE_MONITOR_READ_SERVICE_PATH = "/v1/observations";
var RESOURCE_MONITOR_AGGREGATE_SERVICE_PATH = "/v1/observations/aggregates";
var RESOURCE_MONITOR_LISTENER_HISTORY_SERVICE_PATH = "/v1/observations/listeners";
var RESOURCE_MONITOR_MAX_MESSAGE_BYTES = 512 * 1024;
var RESOURCE_MONITOR_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
var RESOURCE_MONITOR_DEFAULT_MAX_CONNECTIONS = 256;
var RESOURCE_MONITOR_SNAPSHOT_EVENT_LIMIT = 32;
var RESOURCE_MONITOR_AGGREGATE_BUCKET_LIMIT = 1e4;
var RESOURCE_MONITOR_AGGREGATE_DEFINITION_LIMIT = 1000;
var RESOURCE_MONITOR_MAX_SOURCE_ACTIVATIONS = 1000;
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("event operation must be an object");
  return value;
}
function boundSourceActivations(activations) {
  if (activations === undefined)
    return;
  return Object.freeze([...activations].sort((left, right) => left.activatedRecordSequence - right.activatedRecordSequence).slice(-RESOURCE_MONITOR_MAX_SOURCE_ACTIVATIONS));
}
function boundQueryResult(result, maximumBytes, maximumEvents) {
  let eventCount = Math.min(result.events.length, maximumEvents);
  let openSpanCount = Math.min(result.openSpans.length, 1000);
  let activationCount = Math.min(result.sourceActivations?.length ?? 0, RESOURCE_MONITOR_MAX_SOURCE_ACTIVATIONS);
  const sortedActivations = boundSourceActivations(result.sourceActivations) ?? [];
  const suffix = (values, count) => count === 0 ? [] : values.slice(-count);
  const candidate = () => {
    const events = suffix(result.events, eventCount);
    const used = new Set(events.map((event) => event.descriptorHash));
    return Object.freeze({
      definitions: Object.freeze(result.definitions.filter((definition) => used.has(definition.hash))),
      events: Object.freeze(events),
      openSpans: Object.freeze(suffix(result.openSpans, openSpanCount)),
      ...result.sourceActivations === undefined ? {} : { sourceActivations: Object.freeze(suffix(sortedActivations, activationCount)) },
      latestRecordSequence: result.latestRecordSequence
    });
  };
  while (utf8Bytes(candidate()) > maximumBytes) {
    if (openSpanCount > 0)
      openSpanCount = Math.floor(openSpanCount / 2);
    else if (eventCount > 0)
      eventCount = Math.floor(eventCount / 2);
    else if (activationCount > 0)
      activationCount = Math.floor(activationCount / 2);
    else
      throw new RangeError("resource monitor snapshot metadata exceeds the byte limit");
  }
  return candidate();
}
function boundAggregateResult(result) {
  const sourceActivations = boundSourceActivations(result.sourceActivations);
  const lineageTruncated = (result.sourceActivations?.length ?? 0) > (sourceActivations?.length ?? 0);
  const maximumCount = Math.min(result.buckets.length, RESOURCE_MONITOR_AGGREGATE_BUCKET_LIMIT);
  const candidate = (count) => {
    const buckets = result.buckets.slice(result.buckets.length - count);
    const hashes = new Set(buckets.map((bucket) => bucket.descriptorHash));
    const definitions = result.definitions.filter((definition) => hashes.has(definition.hash));
    return Object.freeze({
      bucketMs: result.bucketMs,
      requestedFrom: result.requestedFrom,
      requestedTo: result.requestedTo,
      ...buckets.length === 0 ? {} : {
        actualFrom: Math.min(...buckets.map((bucket) => bucket.startAt)),
        actualTo: Math.max(...buckets.map((bucket) => bucket.endAt))
      },
      partial: result.partial || count < result.buckets.length || lineageTruncated,
      definitions: Object.freeze(definitions),
      buckets: Object.freeze(buckets),
      ...sourceActivations === undefined ? {} : { sourceActivations }
    });
  };
  let low = 0;
  let high = maximumCount;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bounded = candidate(middle);
    if (bounded.definitions.length <= RESOURCE_MONITOR_AGGREGATE_DEFINITION_LIMIT && utf8Bytes(bounded) <= RESOURCE_MONITOR_MAX_RESPONSE_BYTES)
      low = middle;
    else
      high = middle - 1;
  }
  return candidate(low);
}
function boundListenerHistoryResult(result) {
  const maximumCount = Math.min(result.intervals.length, 1e4);
  const candidate = (count) => Object.freeze({
    requestedFrom: result.requestedFrom,
    requestedTo: result.requestedTo,
    partial: result.partial || count < result.intervals.length,
    intervals: Object.freeze(count === 0 ? [] : result.intervals.slice(-count))
  });
  let low = 0;
  let high = maximumCount;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(candidate(middle)) <= RESOURCE_MONITOR_MAX_RESPONSE_BYTES)
      low = middle;
    else
      high = middle - 1;
  }
  return candidate(low);
}
function aggregateResponse(monitor, url) {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const bucket = url.searchParams.get("bucket") ?? "";
  const source = url.searchParams.get("source");
  if (!/^(0|[1-9]\d{0,15})$/.test(from) || !/^[1-9]\d{0,15}$/.test(to) || !/^(60000|900000|3600000|21600000)$/.test(bucket) || source !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source)) {
    return json({ error: "invalid aggregate query" }, 400);
  }
  try {
    return json(boundAggregateResult(monitor.aggregate({
      bucketMs: Number(bucket),
      fromTimestamp: Number(from),
      toTimestamp: Number(to),
      ...source === null ? {} : { sourceInstanceId: source }
    })));
  } catch {
    return json({ error: "invalid aggregate query" }, 400);
  }
}
function listenerHistoryResponse(monitor, url) {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const source = url.searchParams.get("source");
  if (!monitor.listenerHistory || !/^(0|[1-9]\d{0,15})$/.test(from) || !/^[1-9]\d{0,15}$/.test(to) || source !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source)) {
    return json({ error: "invalid listener history query" }, monitor.listenerHistory ? 400 : 501);
  }
  try {
    return json(boundListenerHistoryResult(monitor.listenerHistory({
      fromTimestamp: Number(from),
      toTimestamp: Number(to),
      ...source === null ? {} : { sourceInstanceId: source }
    })));
  } catch {
    return json({ error: "invalid listener history query" }, 400);
  }
}
function utf8Bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function sendAppend(channel, append) {
  const definitions = new Map(append.definitions.map((definition) => [definition.hash, definition]));
  const sourceActivations = boundSourceActivations(append.sourceActivations);
  const envelopeBytes = utf8Bytes({
    type: "events.appended",
    definitions: [],
    events: [],
    ...sourceActivations === undefined ? {} : { sourceActivations },
    latestRecordSequence: append.latestRecordSequence
  });
  let chunkEvents = [];
  let chunkHashes = new Set;
  let estimatedBytes = envelopeBytes;
  const flush = () => {
    if (chunkEvents.length === 0)
      return;
    channel.send(JSON.stringify({
      type: "events.appended",
      definitions: [...chunkHashes].map((hash) => definitions.get(hash)).filter(Boolean),
      events: chunkEvents,
      ...sourceActivations === undefined ? {} : { sourceActivations },
      latestRecordSequence: append.latestRecordSequence
    }));
    chunkEvents = [];
    chunkHashes = new Set;
    estimatedBytes = envelopeBytes;
  };
  for (const event of append.events) {
    const definition = definitions.get(event.descriptorHash);
    if (!definition)
      throw new TypeError("live append references an unknown descriptor");
    const eventBytes = utf8Bytes(event) + 1;
    const definitionBytes = chunkHashes.has(event.descriptorHash) ? 0 : utf8Bytes(definition) + 1;
    if (chunkEvents.length > 0 && estimatedBytes + eventBytes + definitionBytes > RESOURCE_MONITOR_MAX_MESSAGE_BYTES)
      flush();
    if (!chunkHashes.has(event.descriptorHash)) {
      chunkHashes.add(event.descriptorHash);
      estimatedBytes += utf8Bytes(definition) + 1;
    }
    chunkEvents.push(event);
    estimatedBytes += eventBytes;
  }
  flush();
}
function latestSnapshot(monitor, afterRecordSequence) {
  const latestRecordSequence = monitor.stats().acceptedEvents;
  const boundedAfter = Math.max(afterRecordSequence, Math.max(0, latestRecordSequence - RESOURCE_MONITOR_SNAPSHOT_EVENT_LIMIT));
  const query = monitor.query({
    afterRecordSequence: boundedAfter,
    limit: RESOURCE_MONITOR_SNAPSHOT_EVENT_LIMIT
  });
  return boundQueryResult(query, RESOURCE_MONITOR_MAX_MESSAGE_BYTES - utf8Bytes({ type: "events.snapshot" }), RESOURCE_MONITOR_SNAPSHOT_EVENT_LIMIT);
}
function connectionLimit(value) {
  const maxConnections = value ?? RESOURCE_MONITOR_DEFAULT_MAX_CONNECTIONS;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 4096) {
    throw new TypeError("resource monitor connection limit is invalid");
  }
  return maxConnections;
}
function createResourceMonitorReadService(monitor, options = {}) {
  const maxConnections = connectionLimit(options.maxConnections);
  let connections = 0;
  return Object.freeze({
    path: RESOURCE_MONITOR_READ_SERVICE_PATH,
    requiredCapabilities: Object.freeze(["events:read"]),
    maxMessageBytes: RESOURCE_MONITOR_MAX_MESSAGE_BYTES,
    connect(channel) {
      if (connections >= maxConnections)
        throw new RangeError("resource monitor connection limit reached");
      connections += 1;
      let closed = false;
      let stopObserving;
      try {
        channel.send(JSON.stringify({ type: "observations.ready", latestRecordSequence: monitor.stats().acceptedEvents }));
      } catch (error) {
        connections -= 1;
        throw error;
      }
      return Object.freeze({
        message(data) {
          if (data instanceof Uint8Array)
            throw new TypeError("invalid observation operation");
          let operation;
          try {
            operation = record(JSON.parse(data));
          } catch {
            throw new TypeError("invalid observation operation");
          }
          if (operation.type !== "events.observe" || Object.keys(operation).sort().join(",") !== "after,type" || !Number.isSafeInteger(operation.after) || operation.after < 0) {
            throw new TypeError("invalid observation operation");
          }
          stopObserving?.();
          const pending = [];
          let buffering = true;
          stopObserving = monitor.subscribe((append) => {
            if (buffering)
              pending.push(append);
            else
              sendAppend(channel, append);
          });
          try {
            const snapshot = latestSnapshot(monitor, operation.after);
            channel.send(JSON.stringify({ type: "events.snapshot", ...snapshot }));
            for (const append of pending) {
              const events = append.events.filter((event) => event.eventRecordSequence > snapshot.latestRecordSequence);
              if (events.length === 0)
                continue;
              const hashes = new Set(events.map((event) => event.descriptorHash));
              sendAppend(channel, Object.freeze({
                definitions: Object.freeze(append.definitions.filter((definition) => hashes.has(definition.hash))),
                events: Object.freeze(events),
                latestRecordSequence: append.latestRecordSequence
              }));
            }
            buffering = false;
          } catch (error) {
            stopObserving();
            stopObserving = undefined;
            throw error;
          }
        },
        close() {
          if (closed)
            return;
          closed = true;
          stopObserving?.();
          stopObserving = undefined;
          connections -= 1;
        }
      });
    },
    handleRequest(request, url) {
      if (request.method !== "GET")
        return json({ error: "method not allowed" }, 405);
      if (url.pathname === `${RESOURCE_MONITOR_READ_SERVICE_PATH}/stats`)
        return json(monitor.stats());
      if (url.pathname === RESOURCE_MONITOR_AGGREGATE_SERVICE_PATH)
        return aggregateResponse(monitor, url);
      if (url.pathname === RESOURCE_MONITOR_LISTENER_HISTORY_SERVICE_PATH)
        return listenerHistoryResponse(monitor, url);
      if (url.pathname !== RESOURCE_MONITOR_READ_SERVICE_PATH)
        return json({ error: "not found" }, 404);
      const after = url.searchParams.get("after") ?? "0";
      const limit = url.searchParams.get("limit") ?? "1000";
      if (!/^(0|[1-9]\d*)$/.test(after) || !/^[1-9]\d{0,4}$/.test(limit))
        return json({ error: "invalid event query" }, 400);
      try {
        return json(boundQueryResult(monitor.query({ afterRecordSequence: Number(after), limit: Number(limit) }), RESOURCE_MONITOR_MAX_RESPONSE_BYTES, 1000));
      } catch {
        return json({ error: "invalid event query" }, 400);
      }
    }
  });
}

// packages/storage-sqlite/src/index.ts
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "fs";
import { dirname, resolve } from "path";
var APPLICATION_ID = 1263684913;
var SCHEMA_VERSION = 3;
var SCHEMA_DDL = `
CREATE TABLE record_head (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), latest_record_sequence INTEGER NOT NULL CHECK (latest_record_sequence >= 0), duplicate_events INTEGER NOT NULL CHECK (duplicate_events >= 0), sequence_gaps INTEGER NOT NULL CHECK (sequence_gaps >= 0)) STRICT;
CREATE TABLE descriptors (descriptor_hash TEXT PRIMARY KEY CHECK (length(descriptor_hash) = 32 AND descriptor_hash NOT GLOB '*[^0-9a-f]*'), descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json))) STRICT, WITHOUT ROWID;
CREATE TABLE source_heads (
  source_instance_id TEXT PRIMARY KEY,
  latest_source_sequence INTEGER NOT NULL CHECK (latest_source_sequence >= 1),
  replaces_source_instance_id TEXT UNIQUE REFERENCES source_heads(source_instance_id),
  activated_at REAL,
  activated_record_sequence INTEGER UNIQUE CHECK (activated_record_sequence IS NULL OR activated_record_sequence >= 1),
  CHECK ((activated_at IS NULL) = (activated_record_sequence IS NULL)),
  CHECK (replaces_source_instance_id IS NULL OR (activated_at IS NOT NULL AND replaces_source_instance_id <> source_instance_id))
) STRICT, WITHOUT ROWID;
CREATE TABLE raw_events (record_sequence INTEGER PRIMARY KEY CHECK (record_sequence >= 1), source_instance_id TEXT NOT NULL REFERENCES source_heads(source_instance_id), source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1), descriptor_hash TEXT NOT NULL REFERENCES descriptors(descriptor_hash), record_timestamp REAL NOT NULL, event_json TEXT NOT NULL CHECK (json_valid(event_json)), UNIQUE (source_instance_id, source_sequence)) STRICT;
CREATE TABLE sequence_gaps (source_instance_id TEXT NOT NULL REFERENCES source_heads(source_instance_id), missing_from INTEGER NOT NULL CHECK (missing_from >= 1), missing_to INTEGER NOT NULL CHECK (missing_to >= missing_from), detected_record_sequence INTEGER NOT NULL CHECK (detected_record_sequence >= 1), PRIMARY KEY (source_instance_id, missing_from, missing_to)) STRICT, WITHOUT ROWID;
CREATE TABLE open_spans (source_instance_id TEXT NOT NULL REFERENCES source_heads(source_instance_id), span_id TEXT NOT NULL, span_json TEXT NOT NULL CHECK (json_valid(span_json)), PRIMARY KEY (source_instance_id, span_id)) STRICT, WITHOUT ROWID;
CREATE TABLE aggregate_buckets (bucket_ms INTEGER NOT NULL CHECK (bucket_ms IN (60000, 900000, 3600000, 21600000)), start_at REAL NOT NULL, source_instance_id TEXT NOT NULL REFERENCES source_heads(source_instance_id), descriptor_hash TEXT NOT NULL REFERENCES descriptors(descriptor_hash), sample_count INTEGER NOT NULL CHECK (sample_count >= 1), sample_sum REAL NOT NULL, sample_min REAL NOT NULL, sample_max REAL NOT NULL, first_value REAL NOT NULL, last_value REAL NOT NULL, first_record_sequence INTEGER NOT NULL CHECK (first_record_sequence >= 1), last_record_sequence INTEGER NOT NULL CHECK (last_record_sequence >= first_record_sequence), PRIMARY KEY (bucket_ms, start_at, source_instance_id, descriptor_hash), CHECK (sample_min <= sample_max)) STRICT, WITHOUT ROWID;
CREATE TABLE aggregate_series_catalog (source_instance_id TEXT NOT NULL REFERENCES source_heads(source_instance_id), descriptor_hash TEXT NOT NULL REFERENCES descriptors(descriptor_hash), first_record_timestamp REAL NOT NULL, first_record_sequence INTEGER NOT NULL CHECK (first_record_sequence >= 1), PRIMARY KEY (source_instance_id, descriptor_hash)) STRICT, WITHOUT ROWID;
CREATE TABLE aggregate_series_watermarks (bucket_ms INTEGER NOT NULL CHECK (bucket_ms IN (60000, 900000, 3600000, 21600000)), source_instance_id TEXT NOT NULL, descriptor_hash TEXT NOT NULL, compacted_through_record_sequence INTEGER NOT NULL CHECK (compacted_through_record_sequence >= 1), PRIMARY KEY (bucket_ms, source_instance_id, descriptor_hash), FOREIGN KEY (source_instance_id, descriptor_hash) REFERENCES aggregate_series_catalog(source_instance_id, descriptor_hash)) STRICT, WITHOUT ROWID;
CREATE TABLE listener_intervals (source_instance_id TEXT NOT NULL REFERENCES source_heads(source_instance_id), port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535), started_at REAL NOT NULL, last_observed_at REAL NOT NULL CHECK (last_observed_at >= started_at), ended_at REAL CHECK (ended_at IS NULL OR ended_at >= started_at), end_known INTEGER NOT NULL CHECK (end_known IN (0, 1)), pid INTEGER CHECK (pid IS NULL OR pid >= 1), title TEXT, PRIMARY KEY (source_instance_id, port, started_at)) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX listener_intervals_open ON listener_intervals (source_instance_id, port) WHERE ended_at IS NULL;
`;
function integerPragma(database, name) {
  const row = database.query(`PRAGMA ${name}`).get();
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`invalid SQLite ${name}`);
  return value;
}
function preparePrivatePath(input) {
  if (typeof input !== "string" || input.length === 0)
    throw new TypeError("resource monitor database path is required");
  const path = resolve(input);
  const directory = dirname(path);
  for (let candidate = directory;; candidate = dirname(candidate)) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new Error("resource monitor database path must not traverse a symbolic link");
    }
    const parent = dirname(candidate);
    if (parent === candidate)
      break;
  }
  mkdirSync(directory, { recursive: true, mode: 448 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 63) !== 0) {
    throw new Error("resource monitor database directory must be private");
  }
  if (existsSync(path)) {
    const databaseStat = lstatSync(path);
    if (!databaseStat.isFile() || databaseStat.isSymbolicLink())
      throw new Error("resource monitor database path must be a regular file");
  }
  return path;
}
function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[19];
  } catch {
    return;
  }
}
function bootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "unknown";
  }
}
function leaseIsAlive(existing) {
  return Number.isSafeInteger(existing.pid) && existing.bootId === bootId() && existing.startTicks !== undefined && processStartTicks(existing.pid) === existing.startTicks;
}
function acquireWriterLease(databasePath, afterStaleClaim, hooks = {}) {
  const leasePath = `${databasePath}.writer-lock`;
  const owner = Object.freeze({ pid: process.pid, bootId: bootId(), startTicks: processStartTicks(process.pid) ?? "unknown", token: randomUUID() });
  for (let attempt = 0;attempt < 3; attempt += 1) {
    try {
      const descriptor = openSync(leasePath, "wx", 384);
      const openedStat = fstatSync(descriptor);
      try {
        (hooks.write ?? writeSync)(descriptor, JSON.stringify(owner));
        (hooks.fsync ?? fsyncSync)(descriptor);
        closeSync(descriptor);
      } catch (error) {
        try {
          closeSync(descriptor);
        } catch {}
        try {
          const currentStat = lstatSync(leasePath);
          if (openedStat.dev === currentStat.dev && openedStat.ino === currentStat.ino)
            unlinkSync(leasePath);
        } catch {}
        throw error;
      }
      return () => {
        try {
          const current = JSON.parse(readFileSync(leasePath, "utf8"));
          if (current.token === owner.token)
            unlinkSync(leasePath);
        } catch {}
      };
    } catch (error) {
      if (!(error && typeof error === "object" && ("code" in error) && error.code === "EEXIST"))
        throw error;
      let existing;
      try {
        const stat = lstatSync(leasePath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 63) !== 0)
          throw new Error("unsafe writer lease");
        existing = JSON.parse(readFileSync(leasePath, "utf8"));
      } catch {
        throw new Error("resource monitor database writer lease is unreadable");
      }
      if (leaseIsAlive(existing))
        throw new Error("resource monitor database already has an active writer");
      const claimPath = `${leasePath}.reclaim-${owner.token}`;
      try {
        linkSync(leasePath, claimPath);
        const claimed = JSON.parse(readFileSync(claimPath, "utf8"));
        if (leaseIsAlive(claimed))
          throw new Error("resource monitor database already has an active writer");
        afterStaleClaim?.();
        const claimStat = lstatSync(claimPath);
        const currentStat = lstatSync(leasePath);
        if (claimStat.dev === currentStat.dev && claimStat.ino === currentStat.ino)
          unlinkSync(leasePath);
      } catch (claimError) {
        if (!(claimError && typeof claimError === "object" && ("code" in claimError) && claimError.code === "ENOENT"))
          throw claimError;
      } finally {
        try {
          unlinkSync(claimPath);
        } catch {}
      }
    }
  }
  throw new Error("resource monitor database writer lease could not be acquired");
}
function schemaRows(database) {
  return database.query("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}
function validateExactSchema(database) {
  const reference = new Database(":memory:", { strict: true });
  try {
    reference.exec("PRAGMA foreign_keys = ON");
    reference.exec(SCHEMA_DDL);
    if (JSON.stringify(schemaRows(database)) !== JSON.stringify(schemaRows(reference))) {
      throw new Error("resource monitor database schema does not exactly match the current schema");
    }
    const violations = database.query("PRAGMA foreign_key_check").all();
    if (violations.length !== 0)
      throw new Error("resource monitor database schema has foreign-key violations");
  } finally {
    reference.close();
  }
}
function validateAggregateWatermarks(database) {
  const invalid = database.query(`
    SELECT EXISTS (
      SELECT 1
      FROM aggregate_series_catalog c CROSS JOIN record_head h
      WHERE c.first_record_sequence > h.latest_record_sequence
      UNION ALL
      SELECT 1
      FROM (
        SELECT b.bucket_ms, b.source_instance_id, b.descriptor_hash,
          max(b.last_record_sequence) AS evidence_sequence,
          min(c.first_record_sequence) AS first_series_sequence,
          max(w.compacted_through_record_sequence) AS watermark_sequence,
          max(h.latest_record_sequence) AS head_sequence
        FROM aggregate_buckets b
        CROSS JOIN record_head h
        LEFT JOIN aggregate_series_catalog c
          ON c.source_instance_id = b.source_instance_id AND c.descriptor_hash = b.descriptor_hash
        LEFT JOIN aggregate_series_watermarks w
          ON w.bucket_ms = b.bucket_ms AND w.source_instance_id = b.source_instance_id AND w.descriptor_hash = b.descriptor_hash
        GROUP BY b.bucket_ms, b.source_instance_id, b.descriptor_hash
      ) tier
      WHERE tier.first_series_sequence IS NULL
        OR tier.first_series_sequence > tier.evidence_sequence
        OR tier.evidence_sequence > tier.head_sequence
        OR tier.watermark_sequence IS NULL
        OR tier.watermark_sequence <> tier.evidence_sequence
      UNION ALL
      SELECT 1
      FROM aggregate_series_watermarks w
      JOIN aggregate_series_catalog c
        ON c.source_instance_id = w.source_instance_id AND c.descriptor_hash = w.descriptor_hash
      CROSS JOIN record_head h
      GROUP BY w.source_instance_id, w.descriptor_hash
      HAVING min(w.compacted_through_record_sequence) < min(c.first_record_sequence)
        OR min(w.compacted_through_record_sequence) <> max(w.compacted_through_record_sequence)
        OR max(w.compacted_through_record_sequence) > max(h.latest_record_sequence)
    ) AS invalid
  `).get();
  if (invalid?.invalid !== 0)
    throw new Error("resource monitor aggregate watermarks are inconsistent with durable series evidence");
}
function migrate(database) {
  const applicationId = integerPragma(database, "application_id");
  const version = integerPragma(database, "user_version");
  if (applicationId !== APPLICATION_ID && !(applicationId === 0 && version === 0)) {
    throw new Error("resource monitor database application id is incompatible");
  }
  if (version > SCHEMA_VERSION)
    throw new Error("resource monitor database schema is newer than this server");
  if (version === 0)
    database.transaction(() => {
      database.exec(SCHEMA_DDL);
      database.exec("INSERT INTO record_head VALUES (1, 0, 0, 0)");
      database.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
    }).immediate();
  else if (version < SCHEMA_VERSION)
    database.transaction(() => {
      if (version === 1)
        database.exec(`CREATE TABLE listener_intervals (source_instance_id TEXT NOT NULL REFERENCES source_heads(source_instance_id), port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535), started_at REAL NOT NULL, last_observed_at REAL NOT NULL CHECK (last_observed_at >= started_at), ended_at REAL CHECK (ended_at IS NULL OR ended_at >= started_at), end_known INTEGER NOT NULL CHECK (end_known IN (0, 1)), pid INTEGER CHECK (pid IS NULL OR pid >= 1), title TEXT, PRIMARY KEY (source_instance_id, port, started_at)) STRICT, WITHOUT ROWID; CREATE UNIQUE INDEX listener_intervals_open ON listener_intervals (source_instance_id, port) WHERE ended_at IS NULL`);
      database.exec(`
      CREATE TEMP TABLE save_record AS SELECT * FROM record_head;
      CREATE TEMP TABLE save_descriptors AS SELECT * FROM descriptors;
      CREATE TEMP TABLE save_sources AS SELECT source_instance_id, latest_source_sequence FROM source_heads;
      CREATE TEMP TABLE save_raw AS SELECT * FROM raw_events;
      CREATE TEMP TABLE save_gaps AS SELECT * FROM sequence_gaps;
      CREATE TEMP TABLE save_spans AS SELECT * FROM open_spans;
      CREATE TEMP TABLE save_aggregates AS SELECT * FROM aggregate_buckets;
      CREATE TEMP TABLE save_listeners AS SELECT * FROM listener_intervals;
      DROP TABLE listener_intervals; DROP TABLE sequence_gaps; DROP TABLE open_spans; DROP TABLE raw_events; DROP TABLE aggregate_buckets;
      DROP TABLE compaction_watermarks; DROP TABLE source_heads; DROP TABLE descriptors; DROP TABLE record_head;
    `);
      database.exec(SCHEMA_DDL);
      database.exec(`
      INSERT INTO record_head SELECT * FROM save_record;
      INSERT INTO descriptors SELECT * FROM save_descriptors;
      INSERT INTO source_heads (source_instance_id, latest_source_sequence, activated_at, activated_record_sequence)
        SELECT s.source_instance_id, s.latest_source_sequence,
          coalesce(r.record_timestamp, (SELECT min(start_at) FROM save_aggregates WHERE source_instance_id = s.source_instance_id)),
          coalesce(r.record_sequence, (SELECT min(first_record_sequence) FROM save_aggregates WHERE source_instance_id = s.source_instance_id))
        FROM save_sources s
        LEFT JOIN save_raw r ON r.record_sequence = (SELECT min(record_sequence) FROM save_raw WHERE source_instance_id = s.source_instance_id);
      INSERT INTO raw_events SELECT * FROM save_raw;
      INSERT INTO sequence_gaps SELECT * FROM save_gaps;
      INSERT INTO open_spans SELECT * FROM save_spans;
      INSERT INTO aggregate_buckets SELECT * FROM save_aggregates;
      INSERT INTO listener_intervals SELECT * FROM save_listeners;
      INSERT INTO aggregate_series_catalog
        SELECT source_instance_id, descriptor_hash, min(start_at), min(first_record_sequence) FROM save_aggregates GROUP BY source_instance_id, descriptor_hash;
      INSERT INTO aggregate_series_watermarks
        SELECT bucket_ms, source_instance_id, descriptor_hash, max(last_record_sequence) FROM save_aggregates GROUP BY bucket_ms, source_instance_id, descriptor_hash;
      PRAGMA user_version = 3;
    `);
    }).immediate();
  validateExactSchema(database);
}
function createSqliteResourceMonitorWithHooks(options, hooks) {
  const maxAggregateRows = options.maxAggregateBuckets ?? 20000;
  const maxGaps = options.maxGaps ?? 1e5;
  const maxListenerIntervals = options.maxListenerIntervals ?? 20000;
  if (!Number.isSafeInteger(maxAggregateRows) || maxAggregateRows < 1)
    throw new TypeError("maxAggregateBuckets must be a positive safe integer");
  if (!Number.isSafeInteger(maxGaps) || maxGaps < 1)
    throw new TypeError("maxGaps must be a positive safe integer");
  if (!Number.isSafeInteger(maxListenerIntervals) || maxListenerIntervals < 1)
    throw new TypeError("maxListenerIntervals must be a positive safe integer");
  const path = preparePrivatePath(options.path);
  const releaseWriterLease = acquireWriterLease(path);
  const previousUmask = process.umask(63);
  let database;
  try {
    database = new Database(path, { create: true, strict: true });
  } catch (error) {
    releaseWriterLease();
    throw error;
  } finally {
    process.umask(previousUmask);
  }
  try {
    (hooks.chmod ?? chmodSync)(path, 384);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000;");
    const journal = database.query("PRAGMA journal_mode = WAL").get();
    const synchronous = database.query("PRAGMA synchronous").get();
    if (journal?.journal_mode !== "wal" || synchronous?.synchronous !== 2) {
      throw new Error("resource monitor database requires SQLite WAL mode with FULL synchronous commits");
    }
    migrate(database);
    const integrity = database.query("PRAGMA quick_check").get();
    if (integrity?.quick_check !== "ok")
      throw new Error("resource monitor database integrity check failed");
    validateAggregateWatermarks(database);
  } catch (error) {
    try {
      (hooks.close ?? ((value) => value.close()))(database);
    } catch {}
    try {
      releaseWriterLease();
    } catch {}
    throw error;
  }
  const insertDescriptor = database.prepare("INSERT OR IGNORE INTO descriptors (descriptor_hash, descriptor_json) VALUES (?, ?)");
  const upsertSource = database.prepare(`
    INSERT INTO source_heads (source_instance_id, latest_source_sequence, replaces_source_instance_id, activated_at, activated_record_sequence)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source_instance_id) DO UPDATE SET latest_source_sequence = excluded.latest_source_sequence
  `);
  const insertEvent = database.prepare(`
    INSERT INTO raw_events (record_sequence, source_instance_id, source_sequence, descriptor_hash, record_timestamp, event_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertGap = database.prepare(`
    INSERT OR IGNORE INTO sequence_gaps (source_instance_id, missing_from, missing_to, detected_record_sequence)
    VALUES (?, ?, ?, ?)
  `);
  const upsertSpan = database.prepare(`
    INSERT INTO open_spans (source_instance_id, span_id, span_json) VALUES (?, ?, ?)
    ON CONFLICT (source_instance_id, span_id) DO UPDATE SET span_json = excluded.span_json
  `);
  const deleteSpan = database.prepare("DELETE FROM open_spans WHERE source_instance_id = ? AND span_id = ?");
  const updateHead = database.prepare(`
    UPDATE record_head SET
      latest_record_sequence = ?,
      duplicate_events = duplicate_events + ?,
      sequence_gaps = sequence_gaps + ?
    WHERE singleton = 1
  `);
  const upsertAggregate = database.prepare(`
    INSERT INTO aggregate_buckets (
      bucket_ms, start_at, source_instance_id, descriptor_hash,
      sample_count, sample_sum, sample_min, sample_max, first_value, last_value,
      first_record_sequence, last_record_sequence
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bucket_ms, start_at, source_instance_id, descriptor_hash) DO UPDATE SET
      sample_count = sample_count + 1,
      sample_sum = sample_sum + excluded.sample_sum,
      sample_min = min(sample_min, excluded.sample_min),
      sample_max = max(sample_max, excluded.sample_max),
      last_value = excluded.last_value,
      last_record_sequence = excluded.last_record_sequence
  `);
  const pruneRaw = database.prepare(`DELETE FROM raw_events WHERE record_sequence IN (
    SELECT record_sequence FROM raw_events WHERE record_timestamp < ? ORDER BY record_timestamp LIMIT 10000
  )`);
  const pruneGaps = database.prepare(`
    DELETE FROM sequence_gaps
    WHERE (source_instance_id, missing_from, missing_to) IN (
      SELECT source_instance_id, missing_from, missing_to
      FROM sequence_gaps
      ORDER BY detected_record_sequence, source_instance_id, missing_from, missing_to
      LIMIT max(0, (SELECT count(*) FROM sequence_gaps) - ?)
    )
  `);
  const pruneAggregates = database.prepare(`DELETE FROM aggregate_buckets WHERE (bucket_ms, start_at, source_instance_id, descriptor_hash) IN (
    SELECT bucket_ms, start_at, source_instance_id, descriptor_hash FROM aggregate_buckets
    WHERE bucket_ms = ? AND start_at < ? ORDER BY start_at LIMIT 10000
  )`);
  const insertAggregateSeries = database.prepare(`INSERT OR IGNORE INTO aggregate_series_catalog
    (source_instance_id, descriptor_hash, first_record_timestamp, first_record_sequence) VALUES (?, ?, ?, ?)`);
  const advanceSeriesWatermark = database.prepare(`INSERT INTO aggregate_series_watermarks
    (bucket_ms, source_instance_id, descriptor_hash, compacted_through_record_sequence) VALUES (?, ?, ?, ?)
    ON CONFLICT (bucket_ms, source_instance_id, descriptor_hash) DO UPDATE SET
      compacted_through_record_sequence = max(compacted_through_record_sequence, excluded.compacted_through_record_sequence)`);
  const readOpenListeners = database.prepare("SELECT port, started_at, pid, title FROM listener_intervals WHERE source_instance_id = ? AND ended_at IS NULL");
  const insertListener = database.prepare("INSERT INTO listener_intervals (source_instance_id, port, started_at, last_observed_at, ended_at, end_known, pid, title) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)");
  const updateListener = database.prepare("UPDATE listener_intervals SET last_observed_at = ?, pid = coalesce(pid, ?), title = coalesce(title, ?) WHERE source_instance_id = ? AND port = ? AND started_at = ?");
  const closeListener = database.prepare("UPDATE listener_intervals SET ended_at = ?, end_known = 1 WHERE source_instance_id = ? AND port = ? AND started_at = ?");
  const closeReplacedSourceListeners = database.prepare("UPDATE listener_intervals SET ended_at = ?, end_known = 1 WHERE ended_at IS NULL AND source_instance_id = ?");
  const pruneListeners = database.prepare(`DELETE FROM listener_intervals WHERE (source_instance_id, port, started_at) IN (
    SELECT source_instance_id, port, started_at FROM listener_intervals
    WHERE coalesce(ended_at, last_observed_at) < ? ORDER BY coalesce(ended_at, last_observed_at) LIMIT 10000
  )`);
  const readDescriptorJson = database.prepare("SELECT descriptor_json AS json FROM descriptors WHERE descriptor_hash = ?");
  const readHead = () => database.query("SELECT latest_record_sequence, duplicate_events, sequence_gaps FROM record_head WHERE singleton = 1").get();
  const readLatestSourceActivationForSourceId = database.prepare(`
    SELECT h.source_instance_id, h.replaces_source_instance_id, h.activated_at, h.activated_record_sequence
    FROM source_heads h
    WHERE h.activated_record_sequence IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM raw_events e JOIN descriptors d ON d.descriptor_hash = e.descriptor_hash
        WHERE e.source_instance_id = h.source_instance_id AND json_extract(d.descriptor_json, '$.descriptor.sourceId') = ?
      ) OR EXISTS (
        SELECT 1 FROM aggregate_series_catalog c JOIN descriptors d ON d.descriptor_hash = c.descriptor_hash
        WHERE c.source_instance_id = h.source_instance_id AND json_extract(d.descriptor_json, '$.descriptor.sourceId') = ?
      )
    )
    ORDER BY h.activated_record_sequence DESC
    LIMIT 1
  `);
  const pruneByAge = (timestamp) => {
    pruneRaw.run(timestamp - 60 * 60000);
    pruneAggregates.run(60000, timestamp - 24 * 60 * 60000);
    pruneAggregates.run(900000, timestamp - 30 * 24 * 60 * 60000);
    pruneAggregates.run(3600000, timestamp - 180 * 24 * 60 * 60000);
    pruneAggregates.run(21600000, timestamp - 2 * 365 * 24 * 60 * 60000);
    pruneListeners.run(timestamp - 30 * 24 * 60 * 60000);
  };
  const persist = database.transaction((prepared) => {
    for (const definition of prepared.definitions)
      insertDescriptor.run(definition.hash, JSON.stringify(definition));
    if (prepared.latestSourceSequence !== undefined)
      upsertSource.run(prepared.sourceInstanceId, prepared.latestSourceSequence, prepared.sourceActivation?.replacesSourceInstanceId ?? null, prepared.sourceActivation?.activatedAt ?? null, prepared.sourceActivation?.activatedRecordSequence ?? null);
    if (prepared.sourceActivation?.replacesSourceInstanceId !== undefined) {
      closeReplacedSourceListeners.run(prepared.sourceActivation.activatedAt, prepared.sourceActivation.replacesSourceInstanceId);
    }
    for (const event of prepared.events) {
      insertEvent.run(event.eventRecordSequence, event.sourceInstanceId, event.sourceSequence, event.descriptorHash, event.eventRecordTimestamp, JSON.stringify(event));
    }
    const detectedRecordSequence = prepared.result.lastRecordSequence ?? readHead().latest_record_sequence;
    for (const gap of prepared.result.gaps)
      insertGap.run(gap.sourceInstanceId, gap.from, gap.to, detectedRecordSequence);
    for (const change of prepared.spanChanges) {
      if (change.span === null)
        deleteSpan.run(change.sourceInstanceId, change.spanId);
      else
        upsertSpan.run(change.sourceInstanceId, change.spanId, JSON.stringify(change.span));
    }
    const usedDefinitions = new Map(prepared.append?.definitions.map((definition) => [definition.hash, definition]));
    let newestRecordTimestamp;
    for (const event of prepared.events) {
      newestRecordTimestamp = Math.max(newestRecordTimestamp ?? event.eventRecordTimestamp, event.eventRecordTimestamp);
      const storedDefinition = readDescriptorJson.get(event.descriptorHash);
      const eventType = usedDefinitions.get(event.descriptorHash)?.descriptor.eventType ?? (storedDefinition ? JSON.parse(storedDefinition.json).descriptor.eventType : undefined);
      const value = event.measurement?.value;
      if (eventType === "machine.cpu.utilization" || eventType === "machine.memory.utilization") {
        insertAggregateSeries.run(event.sourceInstanceId, event.descriptorHash, event.eventRecordTimestamp, event.eventRecordSequence);
      }
      if ((eventType === "machine.cpu.utilization" || eventType === "machine.memory.utilization") && value !== undefined) {
        for (const bucketMs of [60000, 900000, 3600000, 21600000]) {
          const startAt = Math.floor(event.eventRecordTimestamp / bucketMs) * bucketMs;
          upsertAggregate.run(bucketMs, startAt, event.sourceInstanceId, event.descriptorHash, value, value, value, value, value, event.eventRecordSequence, event.eventRecordSequence);
          advanceSeriesWatermark.run(bucketMs, event.sourceInstanceId, event.descriptorHash, event.eventRecordSequence);
        }
      }
      if (eventType === "machine.tcp.listeners") {
        const encodedPorts = event.attributes?.[1];
        const ports = typeof encodedPorts === "string" ? new Set(encodedPorts.split(",").map(Number).filter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535)) : new Set;
        let owners = new Map;
        try {
          const parsed = JSON.parse(typeof event.attributes?.[3] === "string" ? event.attributes[3] : "{}");
          owners = new Map(Object.entries(parsed).flatMap(([portText, owner]) => {
            const port = Number(portText);
            if (!Number.isSafeInteger(port) || !Array.isArray(owner) || !Number.isSafeInteger(owner[0]) || Number(owner[0]) < 1 || typeof owner[1] !== "string" || owner[1].length < 1 || owner[1].length > 96 || /[\u0000-\u001f\u007f-\u009f]/u.test(owner[1]))
              return [];
            return [[port, Object.freeze({ pid: Number(owner[0]), title: owner[1] })]];
          }));
        } catch {
          owners = new Map;
        }
        const open = readOpenListeners.all(event.sourceInstanceId);
        const byPort = new Map(open.map((row) => [row.port, row]));
        if (event.attributes?.[2] !== true) {
          for (const row of open)
            if (!ports.has(row.port))
              closeListener.run(event.eventRecordTimestamp, event.sourceInstanceId, row.port, row.started_at);
        }
        for (const port of ports) {
          const row = byPort.get(port);
          const owner = owners.get(port);
          if (row)
            updateListener.run(event.eventRecordTimestamp, owner?.pid ?? null, owner?.title ?? null, event.sourceInstanceId, port, row.started_at);
          else
            insertListener.run(event.sourceInstanceId, port, event.eventRecordTimestamp, event.eventRecordTimestamp, owner?.pid ?? null, owner?.title ?? null);
        }
      }
    }
    if (newestRecordTimestamp !== undefined) {
      pruneByAge(newestRecordTimestamp);
    }
    const latestRecordSequence = prepared.append?.latestRecordSequence ?? readHead().latest_record_sequence;
    pruneGaps.run(maxGaps);
    updateHead.run(latestRecordSequence, prepared.result.duplicates, prepared.result.gaps.length);
  });
  const maintain = database.transaction((timestamp) => pruneByAge(timestamp));
  let core;
  try {
    const durableHead = readHead();
    const definitions = database.query("SELECT descriptor_json AS json FROM descriptors ORDER BY descriptor_hash").all().map((row) => JSON.parse(row.json));
    const sourceHeads = database.query("SELECT source_instance_id, latest_source_sequence, replaces_source_instance_id, activated_at, activated_record_sequence FROM source_heads ORDER BY source_instance_id").all().map((row) => Object.freeze({
      sourceInstanceId: row.source_instance_id,
      latestSourceSequence: row.latest_source_sequence,
      ...row.replaces_source_instance_id === null ? {} : { replacesSourceInstanceId: row.replaces_source_instance_id },
      ...row.activated_at === null ? {} : { activatedAt: row.activated_at, activatedRecordSequence: row.activated_record_sequence }
    }));
    const recoveredEvents = database.query(`
    SELECT event_json AS json FROM (
      SELECT record_sequence, event_json FROM raw_events ORDER BY record_sequence DESC LIMIT ?
    ) ORDER BY record_sequence
  `).all(options.maxEvents).map((row) => JSON.parse(row.json));
    const recoveredOpenSpans = database.query("SELECT span_json AS json FROM open_spans ORDER BY source_instance_id, span_id").all().map((row) => JSON.parse(row.json));
    const recovered = Object.freeze({
      definitions: Object.freeze(definitions),
      sourceHeads: Object.freeze(sourceHeads),
      events: Object.freeze(recoveredEvents),
      openSpans: Object.freeze(recoveredOpenSpans),
      latestRecordSequence: durableHead.latest_record_sequence,
      duplicateEvents: durableHead.duplicate_events,
      sequenceGaps: durableHead.sequence_gaps
    });
    core = createResourceMonitor({
      ...options,
      recovered,
      commit(prepared) {
        persist.immediate(prepared);
        return RESOURCE_MONITOR_COMMITTED;
      }
    });
  } catch (error) {
    try {
      database.close();
    } catch {}
    releaseWriterLease();
    throw error;
  }
  let closed = false;
  const ensureOpen = () => {
    if (closed)
      throw new Error("resource monitor database is closed");
  };
  const stats = () => {
    ensureOpen();
    const head = readHead();
    const counts = database.query(`
      SELECT
        (SELECT count(*) FROM descriptors) AS descriptor_count,
        (SELECT count(*) FROM source_heads) AS source_count,
        (SELECT count(*) FROM raw_events) AS retained_events,
        (SELECT count(*) FROM open_spans) AS open_spans
    `).get();
    return Object.freeze({
      acceptedEvents: head.latest_record_sequence,
      duplicateEvents: head.duplicate_events,
      descriptorCount: counts.descriptor_count,
      sourceCount: counts.source_count,
      retainedEvents: Math.min(options.maxEvents, counts.retained_events),
      openSpans: counts.open_spans,
      sequenceGaps: head.sequence_gaps
    });
  };
  return Object.freeze({
    ingest(batch) {
      ensureOpen();
      return core.ingest(batch);
    },
    query(query) {
      ensureOpen();
      return core.query(query);
    },
    latestSourceActivationForSourceId(sourceId) {
      ensureOpen();
      if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > 128)
        throw new TypeError("sourceId is invalid");
      const row = readLatestSourceActivationForSourceId.get(sourceId, sourceId);
      if (!row)
        return;
      return Object.freeze({
        sourceInstanceId: row.source_instance_id,
        ...row.replaces_source_instance_id === null ? {} : { replacesSourceInstanceId: row.replaces_source_instance_id },
        activatedAt: row.activated_at,
        activatedRecordSequence: row.activated_record_sequence
      });
    },
    aggregate(query) {
      ensureOpen();
      const bucketMs = query.bucketMs;
      if (![60000, 900000, 3600000, 21600000].includes(bucketMs))
        throw new TypeError("resource monitor aggregate bucket precision is invalid");
      const requestedFrom = query.fromTimestamp;
      const requestedTo = query.toTimestamp;
      if (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo) || requestedFrom < 0 || requestedTo <= requestedFrom || Math.ceil((requestedTo - requestedFrom) / bucketMs) > 3000) {
        throw new RangeError("resource monitor aggregate range is invalid");
      }
      const sql = `
        SELECT descriptor_hash, source_instance_id, start_at, start_at + bucket_ms AS end_at,
               sample_count, sample_sum AS value_sum, sample_min AS min_value,
               sample_max AS max_value, first_value, last_value
        FROM aggregate_buckets
        WHERE bucket_ms = ? AND start_at < ? AND start_at + bucket_ms > ?${query.sourceInstanceId === undefined ? "" : " AND source_instance_id = ?"}
        ORDER BY start_at DESC, source_instance_id DESC, descriptor_hash DESC
        LIMIT ?
      `;
      const fetched = database.query(sql).all(bucketMs, requestedTo, requestedFrom, ...query.sourceInstanceId === undefined ? [] : [query.sourceInstanceId], maxAggregateRows + 1);
      const truncated = fetched.length > maxAggregateRows;
      const rows = fetched.slice(0, maxAggregateRows).sort((left, right) => left.start_at - right.start_at || left.source_instance_id.localeCompare(right.source_instance_id) || left.descriptor_hash.localeCompare(right.descriptor_hash));
      const buckets = rows.map((row) => Object.freeze({
        descriptorHash: row.descriptor_hash,
        sourceInstanceId: row.source_instance_id,
        startAt: row.start_at,
        endAt: row.end_at,
        count: row.sample_count,
        min: row.min_value,
        max: row.max_value,
        mean: row.value_sum / row.sample_count,
        first: row.first_value,
        last: row.last_value
      }));
      const actualFrom = buckets.length === 0 ? undefined : Math.min(...buckets.map((bucket) => bucket.startAt));
      const actualTo = buckets.length === 0 ? undefined : Math.max(...buckets.map((bucket) => bucket.endAt));
      const used = new Set(buckets.map((bucket) => bucket.descriptorHash));
      const fetchedExpectedSeries = database.query(`
        SELECT c.source_instance_id AS sourceInstanceId, c.descriptor_hash AS descriptorHash,
          coalesce(s.activated_at, c.first_record_timestamp) AS expectedFrom,
          replacement.activated_at AS expectedTo
        FROM aggregate_series_catalog c
        JOIN source_heads s ON s.source_instance_id = c.source_instance_id
        LEFT JOIN source_heads replacement ON replacement.replaces_source_instance_id = c.source_instance_id
        WHERE 1 = 1${query.sourceInstanceId === undefined ? "" : " AND c.source_instance_id = ?"}
        ORDER BY c.source_instance_id, c.descriptor_hash LIMIT ?
      `).all(...query.sourceInstanceId === undefined ? [] : [query.sourceInstanceId], maxAggregateRows + 1);
      const expectedSeriesTruncated = fetchedExpectedSeries.length > maxAggregateRows;
      const expectedSeries = fetchedExpectedSeries.slice(0, maxAggregateRows).map((series) => ({
        sourceInstanceId: series.sourceInstanceId,
        descriptorHash: series.descriptorHash,
        expectedFrom: series.expectedFrom,
        ...series.expectedTo === null ? {} : { expectedTo: series.expectedTo }
      }));
      const sourceActivations = database.query(`SELECT source_instance_id, replaces_source_instance_id, activated_at, activated_record_sequence
        FROM source_heads WHERE activated_at IS NOT NULL ORDER BY activated_record_sequence`).all().map((head) => Object.freeze({
        sourceInstanceId: head.source_instance_id,
        ...head.replaces_source_instance_id === null ? {} : { replacesSourceInstanceId: head.replaces_source_instance_id },
        activatedAt: head.activated_at,
        activatedRecordSequence: head.activated_record_sequence
      }));
      return Object.freeze({
        bucketMs,
        requestedFrom,
        requestedTo,
        ...actualFrom === undefined ? {} : { actualFrom, actualTo },
        partial: truncated || expectedSeriesTruncated || hasPartialAggregateCoverage(buckets, bucketMs, requestedFrom, requestedTo, expectedSeries),
        definitions: Object.freeze([...used].map((hash) => {
          const row = readDescriptorJson.get(hash);
          return row ? JSON.parse(row.json) : undefined;
        }).filter((definition) => definition !== undefined)),
        buckets: Object.freeze(buckets),
        sourceActivations: Object.freeze(sourceActivations)
      });
    },
    listenerHistory(query) {
      ensureOpen();
      if (!Number.isSafeInteger(query.fromTimestamp) || query.fromTimestamp < 0 || !Number.isSafeInteger(query.toTimestamp) || query.toTimestamp <= query.fromTimestamp || query.toTimestamp - query.fromTimestamp > 30 * 24 * 60 * 60000) {
        throw new RangeError("resource monitor listener history range is invalid");
      }
      const sql = `SELECT source_instance_id, port, started_at, last_observed_at, ended_at, end_known, pid, title
        FROM listener_intervals
        WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)${query.sourceInstanceId === undefined ? "" : " AND source_instance_id = ?"}
        ORDER BY started_at DESC, source_instance_id DESC, port DESC LIMIT ?`;
      const fetched = database.query(sql).all(query.toTimestamp, query.fromTimestamp, ...query.sourceInstanceId === undefined ? [] : [query.sourceInstanceId], maxListenerIntervals + 1);
      const truncated = fetched.length > maxListenerIntervals;
      const intervals = fetched.slice(0, maxListenerIntervals).reverse().map((row) => Object.freeze({
        sourceInstanceId: String(row.source_instance_id),
        port: Number(row.port),
        startedAt: Number(row.started_at),
        lastObservedAt: Number(row.last_observed_at),
        ...row.ended_at === null ? {} : { endedAt: Number(row.ended_at) },
        endKnown: row.end_known === 1,
        ...row.pid === null ? {} : { pid: Number(row.pid) },
        ...row.title === null ? {} : { title: String(row.title) }
      }));
      return Object.freeze({ requestedFrom: query.fromTimestamp, requestedTo: query.toTimestamp, partial: truncated, intervals: Object.freeze(intervals) });
    },
    stats,
    subscribe(listener) {
      ensureOpen();
      return core.subscribe(listener);
    },
    checkpoint() {
      ensureOpen();
      const timestamp = options.now?.() ?? Date.now();
      if (!Number.isFinite(timestamp) || timestamp < 0)
        throw new TypeError("resource monitor clock must return a non-negative finite timestamp");
      maintain.immediate(timestamp);
      database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    },
    close() {
      if (closed)
        return;
      try {
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        closed = true;
        try {
          database.close();
        } finally {
          releaseWriterLease();
        }
      }
    }
  });
}
function createSqliteResourceMonitor(options) {
  return createSqliteResourceMonitorWithHooks(options, {});
}

// packages/publish-sdk/src/gateway-server.ts
function requiredAbsolute(name) {
  const value = process.env[name];
  if (!value || !resolve2(value).startsWith("/"))
    throw new Error(`${name} must be absolute`);
  return resolve2(value);
}
function requiredPort() {
  const value = process.env.KLIVCORE_GATEWAY_PORT;
  if (!value || !/^[1-9]\d{0,4}$/u.test(value) || Number(value) > 65535)
    throw new Error("KLIVCORE_GATEWAY_PORT is invalid");
  return Number(value);
}
async function privateToken(path) {
  try {
    const handle = await open(path, "wx", 384);
    const token = randomBytes(32).toString("base64url");
    try {
      await handle.writeFile(`${token}
`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 384);
    return token;
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
    const token = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token))
      throw new Error("Resource Monitor ingestion token is invalid");
    await chmod(path, 384);
    return token;
  }
}
function authorized(request, token) {
  const value = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
  if (!value)
    return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
function json2(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
var home = requiredAbsolute("KLIVCORE_GATEWAY_HOME");
var configPath = requiredAbsolute("KLIVCORE_GATEWAY_CONFIG");
var port = requiredPort();
await mkdir(home, { recursive: true, mode: 448 });
var config = JSON.parse(await readFile(configPath, "utf8"));
var maxEvents = config.maxEvents === undefined ? 1e5 : Number(config.maxEvents);
if (!Number.isSafeInteger(maxEvents) || maxEvents < 1000 || maxEvents > 1e7)
  throw new TypeError("Resource Monitor maxEvents is invalid");
var token = await privateToken(resolve2(home, "ingest-token"));
var monitor = createSqliteResourceMonitor({ path: resolve2(home, "resource-monitor.sqlite"), maxEvents });
var readService = createResourceMonitorReadService(monitor);
var collectorRuntimePath = resolve2(home, "collector-runtime.json");
var collectorRuntimeTemp = `${collectorRuntimePath}.new`;
await writeFile(collectorRuntimeTemp, `${JSON.stringify({
  schemaVersion: 1,
  initialReplacesSourceInstanceId: monitor.latestSourceActivationForSourceId("linux.machine")?.sourceInstanceId ?? null
}, null, 2)}
`, { mode: 384 });
await chmod(collectorRuntimeTemp, 384);
await rename(collectorRuntimeTemp, collectorRuntimePath);
var server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return json2({ status: "ok", gateway: "resource-monitor-v1" });
    if (request.method === "GET" && (url.pathname === "/v1/observations" || url.pathname === "/v1/observations/aggregates" || url.pathname === "/v1/observations/listeners"))
      return readService.handleRequest(request, url);
    if (request.method === "POST" && url.pathname === "/v1/events") {
      if (!authorized(request, token))
        return json2({ error: "unauthorized" }, 401);
      const length = request.headers.get("content-length");
      if (length !== null && (!/^(0|[1-9]\d*)$/u.test(length) || Number(length) > RESOURCE_MONITOR_MAX_MESSAGE_BYTES))
        return json2({ error: "request too large" }, 413);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > RESOURCE_MONITOR_MAX_MESSAGE_BYTES)
        return json2({ error: "request too large" }, 413);
      try {
        const batch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        return json2(monitor.ingest(batch));
      } catch {
        return json2({ error: "invalid event batch" }, 400);
      }
    }
    return json2({ error: "not found" }, 404);
  }
});
console.log(`Canonical Resource Monitor Gateway ready on http://127.0.0.1:${server.port}`);
var stopping = false;
function stop() {
  if (stopping)
    return;
  stopping = true;
  server.stop(true);
  monitor.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
