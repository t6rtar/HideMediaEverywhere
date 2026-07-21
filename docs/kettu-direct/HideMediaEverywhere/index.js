(() => {
  const metro = vendetta.metro;
  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const storage = vendetta.plugin.storage;
  const logger = vendetta.logger;
  let unpatchRowData = null;
  let unpatchNativeRows = null;
  let unpatchNativeClearRows = null;
  let nativeUpdateRowsCalls = 0;
  let nativeClearRowsCalls = 0;
  let lastNativeInvocation = "No DCDChatManager.updateRows call captured yet.";
  let nativeMediaCaptures = [];
  let latestNativeArgsByTag = new Map();
  let replayingNativeRows = false;
  let nativeReplayAttempts = 0;
  let nativeReplaySubmissions = 0;
  let nativeCaptureInvalidations = 0;
  let nativeClearRowsGuardActive = false;
  let lastNativeCapture = "No native media batch captured yet.";
  let lastNativeReplay = "No native media replay attempted yet.";
  let lastNativeInvalidation = "No native media capture invalidated yet.";
  const MAX_NATIVE_MEDIA_CAPTURES = 8;
  const MAX_NATIVE_CAPTURE_AGE_MS = 60 * 1000;

  function keysOf(value) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return [];
    try {
      return Object.keys(value);
    } catch {
      return [];
    }
  }

  function findByProps(props) {
    if (typeof metro.findByProps === "function") return metro.findByProps(...props);
    if (typeof metro.find === "function" && metro.filters?.byProps) {
      return metro.find(metro.filters.byProps(...props));
    }
    return undefined;
  }

  function unwrapModule(record) {
    return record?.publicModule?.exports ?? record?.exports ?? record;
  }

  function functionSource(value) {
    if (typeof value !== "function") return "";
    try {
      return Function.prototype.toString.call(value);
    } catch {
      return "";
    }
  }

  function sourceMatchSnippet(source, pattern) {
    const match = pattern.exec(source);
    pattern.lastIndex = 0;
    if (!match) return "";
    const start = Math.max(0, match.index - 90);
    const end = Math.min(source.length, match.index + match[0].length + 150);
    return source.slice(start, end).replace(/\s+/g, " ");
  }

  function scanMenuModules() {
    const pattern = /MessageLongPressActionSheet|MessageLongPress|MessagesHandlers|DCDChat|ActionSheetRow|showSimpleActionSheet|openLazy|context.?menu/gi;
    const lines = [
      `menu discovery ${new Date().toISOString()}`,
      `metroKeys=${keysOf(metro).sort().join(",")}`,
      "name probes:"
    ];
    const names = ["MessageLongPressActionSheet", "MessagesHandlers", "DCDChat", "ActionSheetRow"];
    for (const name of names) {
      for (const method of ["findByNameAll", "findByDisplayNameAll", "findByTypeNameAll"]) {
        if (typeof metro[method] !== "function") continue;
        try {
          const matches = metro[method](name);
          const list = Array.isArray(matches) ? matches : matches ? [matches] : [];
          lines.push(`${method}(${name})=${list.length}${list.length ? ` [${list.slice(0, 8).map((value) => keysOf(value).join("|") || typeof value).join("; ")}]` : ""}`);
        } catch (error) {
          lines.push(`${method}(${name})=ERROR ${String(error)}`);
        }
      }
    }

    lines.push("registry matches:");
    let scanned = 0;
    let matched = 0;
    try {
      for (const [id, record] of Object.entries(metro.modules || {})) {
        scanned++;
        const exports = unwrapModule(record);
        const candidates = [["<exports>", exports], ["default", exports?.default]];
        for (const key of keysOf(exports).slice(0, 160)) {
          let value;
          try {
            value = exports[key];
          } catch {
            continue;
          }
          candidates.push([key, value]);
        }
        for (const key of keysOf(record).slice(0, 40)) {
          let value;
          try {
            value = record[key];
          } catch {
            continue;
          }
          if (typeof value === "function") candidates.push([`record.${key}`, value]);
        }

        const moduleLines = [];
        const seen = new Set();
        for (const [key, value] of candidates) {
          if (!value || seen.has(value)) continue;
          seen.add(value);
          const display = typeof value === "function"
            ? value.displayName || value.name || "anonymous"
            : value?.displayName || value?.name || value?.render?.displayName || value?.render?.name || "";
          const source = functionSource(value) || functionSource(value?.render);
          pattern.lastIndex = 0;
          const keyText = `${key} ${display} ${keysOf(value).join(" ")}`;
          const keyHit = pattern.test(keyText);
          pattern.lastIndex = 0;
          const snippet = sourceMatchSnippet(source, pattern);
          if (!keyHit && !snippet) continue;
          moduleLines.push(`${key}: type=${typeof value} name=${display || "<none>"} keys=${keysOf(value).slice(0, 50).join(",") || "<none>"}${snippet ? ` source=${snippet}` : ""}`);
        }
        if (!moduleLines.length) continue;
        lines.push(`${id}: exports=${keysOf(exports).slice(0, 100).join(",") || "<none>"}`);
        lines.push(...moduleLines.slice(0, 12).map((line) => `  ${line}`));
        matched++;
        if (matched >= 100) {
          lines.push("<registry report capped at 100 modules>");
          break;
        }
      }
    } catch (error) {
      lines.push(`registry scan error=${String(error)}`);
    }
    lines.push(`scanned=${scanned} matched=${matched}`);
    storage.menuDiscoveryReport = lines.join("\n");
    return storage.menuDiscoveryReport;
  }

  function filenameFromUrl(url) {
    if (typeof url !== "string") return "";
    try {
      const pathname = new URL(url).pathname;
      return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
    } catch {
      const clean = url.split(/[?#]/, 1)[0];
      return clean.slice(clean.lastIndexOf("/") + 1);
    }
  }

  function attachmentFilename(attachment) {
    const filename = attachment?.filename || filenameFromUrl(attachment?.url) || filenameFromUrl(attachment?.videoUrl);
    return typeof filename === "string" ? filename.trim() : "";
  }

  function authorIdFrom(message) {
    const value = message?.author?.id ?? message?.authorId ?? message?.author_id ?? "*";
    return String(value || "*");
  }

  function attachmentKey(authorId, filename) {
    return `${authorId || "*"}:${filename.toLowerCase()}`;
  }

  function globalAttachmentKey(filename) {
    return attachmentKey("*", filename);
  }

  function normalizeBlockedKey(key) {
    const colon = key.indexOf(":");
    return colon === -1 ? globalAttachmentKey(key) : globalAttachmentKey(key.slice(colon + 1));
  }

  function readBlocked() {
    return new Set(
      String(storage.blockedKeys || "")
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(normalizeBlockedKey)
    );
  }

  function writeBlocked(blocked) {
    storage.blockedKeys = [...blocked].sort().join("\n");
  }

  function readRecent() {
    try {
      const parsed = JSON.parse(storage.recentAttachments || "[]");
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item?.key === "string" && typeof item?.filename === "string") : [];
    } catch {
      storage.recentAttachments = "[]";
      return [];
    }
  }

  function rememberAttachments(message, attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return;
    const authorId = authorIdFrom(message);
    const messageId = String(message?.id ?? message?.messageId ?? message?.message_id ?? "");
    const channelId = String(message?.channel_id ?? message?.channelId ?? message?.messageChannelId ?? "");
    const recent = readRecent();
    for (const attachment of attachments) {
      const filename = attachmentFilename(attachment);
      if (!filename) continue;
      const key = attachmentKey(authorId, filename);
      const oldIndex = recent.findIndex((item) => item.key === key);
      if (oldIndex !== -1) recent.splice(oldIndex, 1);
      recent.unshift({ key, filename, authorId, channelId, messageId });
    }
    storage.recentAttachments = JSON.stringify(recent.slice(0, 30));
  }

  function attachmentMatchLines(label, attachments, blocked) {
    if (!Array.isArray(attachments)) return [`${label}: not an array`];
    if (attachments.length === 0) return [`${label}: empty`];
    return attachments.map((attachment, index) => {
      const filename = attachmentFilename(attachment) || "<no filename>";
      const key = filename === "<no filename>" ? "<none>" : globalAttachmentKey(filename);
      return `${label}[${index}]: filename=${filename} key=${key} selected=${blocked.has(key)}`;
    });
  }

  function cloneWithOverrides(value, overrides) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, nextValue] of Object.entries(overrides)) {
      descriptors[key] = {
        value: nextValue,
        writable: true,
        enumerable: descriptors[key]?.enumerable ?? true,
        configurable: true
      };
    }
    const clone = Object.create(Object.getPrototypeOf(value));
    Object.defineProperties(clone, descriptors);
    return clone;
  }

  function shouldHideAttachment(attachment, blocked) {
    if (storage.hideAllAttachments) return true;
    const filename = attachmentFilename(attachment);
    return !!filename && blocked.has(globalAttachmentKey(filename));
  }

  function stringId(value) {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }

  function nativeRowMessageId(row) {
    return stringId(
      row?.message?.id ??
      row?.message?.messageId ??
      row?.message?.message_id ??
      row?.messageId ??
      row?.message_id ??
      row?.id
    );
  }

  function nativeRowChannelId(row) {
    return stringId(
      row?.message?.channel_id ??
      row?.message?.channelId ??
      row?.message?.messageChannelId ??
      row?.channelId ??
      row?.channel_id
    );
  }

  function nativeRowChangeType(row) {
    return typeof row?.changeType === "number" ? row.changeType : null;
  }

  function nativeRowIndex(row) {
    const index = row?.index;
    return typeof index === "number" && index >= 0 && Math.floor(index) === index ? index : null;
  }

  function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function nativeArgumentType(value) {
    return value === null ? "null" : typeof value;
  }

  function nativeArgumentsAreReplaySafe(args) {
    if (!Array.isArray(args) || args.length !== 7 || args[6] !== false) return false;
    return args.every((value, index) => {
      if (index === 1 || value === null) return true;
      return ["string", "number", "boolean", "undefined"].includes(typeof value);
    });
  }

  function nativeTagKey(value) {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return `${typeof value}:${String(value)}`;
  }

  function invalidateNativeCapturesForTag(tagKey, reason, messageIds) {
    if (!tagKey) return;
    const ids = new Set(messageIds || []);
    const before = nativeMediaCaptures.length;
    nativeMediaCaptures = nativeMediaCaptures.filter((capture) => {
      if (capture.tagKey !== tagKey) return true;
      if (ids.size === 0) return false;
      return !capture.entries.some((entry) => ids.has(entry.messageId));
    });
    const removed = before - nativeMediaCaptures.length;
    if (removed > 0) {
      nativeCaptureInvalidations += removed;
      lastNativeInvalidation = `${reason}. tag=${tagKey} removed=${removed}`;
    }
  }

  function captureNativeMediaBatch(args, rows, mediaRows) {
    if (replayingNativeRows || typeof args?.[1] !== "string") return;

    const tagKey = nativeTagKey(args[0]);
    if (!tagKey) return;

    const entries = [];
    const filenames = [];
    for (const row of mediaRows) {
      const rowFilenames = [];
      for (const attachment of row.message.attachments) {
        const filename = attachmentFilename(attachment);
        if (filename) {
          rowFilenames.push(filename);
          filenames.push(filename);
        }
      }
      const messageId = nativeRowMessageId(row);
      if (!messageId || rowFilenames.length === 0) continue;
      entries.push({
        messageId,
        channelId: nativeRowChannelId(row),
        changeType: nativeRowChangeType(row),
        index: nativeRowIndex(row),
        filenames: uniqueStrings(rowFilenames),
        rowJson: JSON.stringify(row)
      });
    }

    const capture = {
      args: args.slice(),
      rowsJson: args[1],
      tagKey,
      capturedAt: Date.now(),
      entries,
      messageIds: uniqueStrings(entries.map((entry) => entry.messageId)),
      channelIds: uniqueStrings(entries.map((entry) => entry.channelId)),
      filenames: uniqueStrings(filenames),
      argumentTypes: args.map(nativeArgumentType),
      replaySafeArguments: nativeArgumentsAreReplaySafe(args)
    };

    nativeMediaCaptures = [
      capture,
      ...nativeMediaCaptures.filter((item) =>
        item.args?.[0] !== capture.args[0] || item.rowsJson !== capture.rowsJson
      )
    ].slice(0, MAX_NATIVE_MEDIA_CAPTURES);

    lastNativeCapture = [
      `capturedAt=${new Date(capture.capturedAt).toISOString()}`,
      `rows=${rows.length}`,
      `mediaRows=${mediaRows.length}`,
      `messageIds=${capture.messageIds.join(",") || "<not exposed>"}`,
      `channelIds=${capture.channelIds.join(",") || "<not exposed>"}`,
      `filenames=${capture.filenames.join(",") || "<none>"}`,
      `changeTypes=${capture.entries.map((entry) => entry.changeType ?? "<missing>").join(",") || "<none>"}`,
      `indices=${capture.entries.map((entry) => entry.index ?? "<missing>").join(",") || "<none>"}`,
      `argTypes=${capture.argumentTypes.join(",")}`,
      `replaySafe=${capture.replaySafeArguments}`
    ].join(" ");
  }

  function matchingCapturedRow(capture, target) {
    const messageId = stringId(target?.messageId);
    const filename = attachmentFilename(target);
    if (!messageId || !filename || !capture.replaySafeArguments) return null;
    if (Date.now() - capture.capturedAt > MAX_NATIVE_CAPTURE_AGE_MS) return null;

    const channelId = stringId(target?.channelId);
    return capture.entries.find((entry) =>
      entry.messageId === messageId &&
      (entry.changeType === 0 || entry.changeType === 2) &&
      entry.index !== null &&
      entry.filenames.includes(filename) &&
      (!channelId || !entry.channelId || entry.channelId === channelId)
    ) || null;
  }

  function replayCapturedNativeRows(target) {
    nativeReplayAttempts++;
    const manager = RN.NativeModules?.DCDChatManager;
    if (!manager || typeof manager.updateRows !== "function") {
      lastNativeReplay = "Skipped: DCDChatManager.updateRows is unavailable.";
      return false;
    }
    if (!nativeClearRowsGuardActive) {
      lastNativeReplay = "Skipped: clearRows invalidation guard is unavailable.";
      return false;
    }

    let capture = null;
    let capturedRow = null;
    for (const item of nativeMediaCaptures) {
      const row = matchingCapturedRow(item, target);
      if (!row) continue;
      capture = item;
      capturedRow = row;
      break;
    }
    if (!capture || !capturedRow) {
      const freshCount = nativeMediaCaptures.filter((item) =>
        Date.now() - item.capturedAt <= MAX_NATIVE_CAPTURE_AGE_MS
      ).length;
      const safeCount = nativeMediaCaptures.filter((item) => item.replaySafeArguments).length;
      lastNativeReplay = `Skipped: no recent direct media row matched message ${target?.messageId || "<none>"} and filename ${attachmentFilename(target) || "<none>"}. Fresh captures=${freshCount}. Replay-safe captures=${safeCount}.`;
      return false;
    }

    const ageMs = Date.now() - capture.capturedAt;
    const latest = latestNativeArgsByTag.get(capture.tagKey);
    if (!latest || Date.now() - latest.updatedAt > MAX_NATIVE_CAPTURE_AGE_MS) {
      lastNativeReplay = `Skipped: latest native arguments for ${capture.tagKey} are stale or missing.`;
      return false;
    }
    if (latest.args.length !== 7 || latest.args[6] !== false) {
      lastNativeReplay = `Skipped: latest native call was not an explicit seven-argument non-reload update. argsLength=${latest.args.length} forceReload=${String(latest.args[6])}`;
      return false;
    }
    const replayArgs = latest.args.slice();
    let replayRow;
    try {
      replayRow = JSON.parse(capturedRow.rowJson);
    } catch (error) {
      lastNativeReplay = `Skipped: captured native row could not be decoded: ${String(error)}`;
      return false;
    }
    if (
      nativeRowMessageId(replayRow) !== capturedRow.messageId ||
      nativeRowIndex(replayRow) !== capturedRow.index ||
      nativeRowChangeType(replayRow) !== capturedRow.changeType
    ) {
      lastNativeReplay = "Skipped: captured native row identity changed before replay.";
      return false;
    }
    replayRow.changeType = 2;
    replayArgs[1] = JSON.stringify([replayRow]);
    replayArgs[3] = null;
    replayingNativeRows = true;
    try {
      manager.updateRows.apply(manager, replayArgs);
      nativeReplaySubmissions++;
      lastNativeReplay = `Submitted one matching native media row as changeType=2 without stale scroll data. capturedChangeType=${capturedRow.changeType} index=${capturedRow.index} ageMs=${ageMs} messageId=${target.messageId} filename=${attachmentFilename(target)}`;
      return true;
    } catch (error) {
      lastNativeReplay = `Native replay failed: ${String(error)}`;
      return false;
    } finally {
      replayingNativeRows = false;
    }
  }

  function installPatch() {
    const rowModule = findByProps(["generateMessageRowData"]);
    if (!rowModule || typeof rowModule.generateMessageRowData !== "function") {
      storage.patchStatus = "generateMessageRowData was not found.";
      return;
    }
    if (typeof vendetta.patcher?.after !== "function") {
      storage.patchStatus = `patcher.after unavailable. Keys: ${keysOf(vendetta.patcher).join(", ") || "<none>"}`;
      return;
    }

    unpatchRowData = vendetta.patcher.after("generateMessageRowData", rowModule, (args, result) => {
      storage.rowCallCount = (storage.rowCallCount || 0) + 1;
      try {
        const sourceMessage = args?.[0]?.message;
        const blocked = readBlocked();
        rememberAttachments(sourceMessage, sourceMessage?.attachments);
        const sourceAttachments = sourceMessage?.attachments;
        if (Array.isArray(sourceAttachments) && sourceAttachments.length > 0) {
          storage.mediaRowCount = (storage.mediaRowCount || 0) + 1;
          storage.latestMatchReport = [
            `match ${new Date().toISOString()}`,
            "postGenerationReplacement=true",
            `blockedKeys=${[...blocked].join(", ") || "<none>"}`,
            ...attachmentMatchLines("source", sourceAttachments, blocked)
          ].join("\n");
        }
        const rowAttachments = result?.message?.attachments;
        rememberAttachments(sourceMessage, rowAttachments);
        if (Array.isArray(rowAttachments) && rowAttachments.length > 0) {
          const visible = rowAttachments.filter((attachment) => !shouldHideAttachment(attachment, blocked));
          const removed = rowAttachments.length - visible.length;
          storage.latestMatchReport = [
            storage.latestMatchReport || `match ${new Date().toISOString()}`,
            ...attachmentMatchLines("result", rowAttachments, blocked || new Set()),
            `hideAllAttachments=${!!storage.hideAllAttachments}`,
            `replacementRemoved=${removed}`
          ].join("\n");
          if (removed > 0) {
            const messageOverrides = { attachments: visible };
            if (visible.length === 0) {
              messageOverrides.useAttachmentGridLayout = false;
              messageOverrides.useAttachmentUploadPreview = false;
            }
            const nextMessage = cloneWithOverrides(result.message, messageOverrides);
            const nextResult = cloneWithOverrides(result, { message: nextMessage });
            storage.replacementCount = (storage.replacementCount || 0) + removed;
            return nextResult;
          }
        }
      } catch (error) {
        storage.patchStatus = `Post-generation replacement error: ${String(error)}`;
      }
    });

    storage.patchStatus = "Active. Replacing completed row data without changing Discord messages.";
    logger.log("[HideMediaEverywhere]", storage.patchStatus);
  }

  function installNativeClearRowsPatch(manager) {
    if (unpatchNativeClearRows) return true;
    nativeClearRowsGuardActive = false;
    if (typeof manager?.clearRows !== "function") {
      storage.nativeClearRowsGuardStatus = `DCDChatManager.clearRows unavailable. Keys: ${keysOf(manager).join(", ") || "<none>"}`;
      return false;
    }
    if (typeof vendetta.patcher?.before !== "function") {
      storage.nativeClearRowsGuardStatus = "patcher.before unavailable for DCDChatManager.clearRows.";
      return false;
    }

    try {
      unpatchNativeClearRows = vendetta.patcher.before("clearRows", manager, (args) => {
        nativeClearRowsCalls++;
        const tagKey = nativeTagKey(args?.[0]);
        invalidateNativeCapturesForTag(tagKey, "Native clearRows invalidated this chat tag");
        if (tagKey) latestNativeArgsByTag.delete(tagKey);
      });
      nativeClearRowsGuardActive = true;
      storage.nativeClearRowsGuardStatus = "Active. Invalidating captured rows when the native chat tag clears.";
      return true;
    } catch (error) {
      storage.nativeClearRowsGuardStatus = `DCDChatManager.clearRows patch failed: ${String(error)}`;
      return false;
    }
  }

  function installNativeRowsPatch() {
    if (unpatchNativeRows) return;
    try {
      const manager = RN.NativeModules?.DCDChatManager;
      if (!manager || typeof manager.updateRows !== "function") {
        storage.nativePatchStatus = `DCDChatManager.updateRows unavailable. Keys: ${keysOf(manager).join(", ") || "<none>"}`;
        return;
      }
      if (typeof vendetta.patcher?.before !== "function") {
        storage.nativePatchStatus = "patcher.before unavailable for DCDChatManager.updateRows.";
        return;
      }

      installNativeClearRowsPatch(manager);

      unpatchNativeRows = vendetta.patcher.before("updateRows", manager, (args) => {
        nativeUpdateRowsCalls++;
        const invocationKind = replayingNativeRows ? "replay" : "natural";
        lastNativeInvocation = `call=${nativeUpdateRowsCalls} kind=${invocationKind} argsLength=${args?.length ?? 0} argTypes=${Array.isArray(args) ? args.map(nativeArgumentType).join(",") : "<not-array>"}`;
        try {
          if (typeof args?.[1] !== "string") {
            storage.nativePatchStatus = `DCDChatManager.updateRows rows argument was ${typeof args?.[1]}, not a string.`;
            return;
          }

          const refreshTarget = String(storage.refreshTarget || "");
          const targetSeparator = refreshTarget.indexOf(":");
          const targetMessageId = targetSeparator === -1 ? "" : refreshTarget.slice(targetSeparator + 1);
          const batchHasRefreshTarget = !!targetMessageId && args[1].includes(targetMessageId);
          lastNativeInvocation += ` batchHasRefreshTarget=${batchHasRefreshTarget}`;
          const rows = JSON.parse(args[1]);
          if (!Array.isArray(rows)) {
            storage.nativePatchStatus = "DCDChatManager.updateRows payload was not an array.";
            return;
          }

          const tagKey = nativeTagKey(args[0]);
          const replaySafeArguments = nativeArgumentsAreReplaySafe(args);
          if (!replayingNativeRows && tagKey) {
            if (replaySafeArguments) {
              latestNativeArgsByTag.set(tagKey, { args: args.slice(), updatedAt: Date.now() });
            } else {
              invalidateNativeCapturesForTag(tagKey, "An incompatible native update invalidated this chat tag");
              latestNativeArgsByTag.delete(tagKey);
            }
          }

          if (!replayingNativeRows && tagKey) {
            const structuralChange = rows.some((row) => {
              const changeType = nativeRowChangeType(row);
              return changeType === 1 || changeType === 3;
            });
            if (structuralChange) {
              invalidateNativeCapturesForTag(tagKey, "A later native insert/delete invalidated this chat tag");
            } else {
              const changedMessageIds = uniqueStrings(rows.map(nativeRowMessageId));
              if (changedMessageIds.length > 0) {
                invalidateNativeCapturesForTag(tagKey, "A newer native row replaced the captured target", changedMessageIds);
              }
            }
          }

          const mediaRows = rows.filter((row) =>
            Array.isArray(row?.message?.attachments) && row.message.attachments.length > 0
          );
          if (mediaRows.length === 0) return;

          captureNativeMediaBatch(args, rows, mediaRows);
          storage.nativeMediaBatchCount = (storage.nativeMediaBatchCount || 0) + 1;
          if (replayingNativeRows) {
            storage.nativeReplayMediaBatchCount = (storage.nativeReplayMediaBatchCount || 0) + 1;
          } else {
            storage.nativeNaturalMediaBatchCount = (storage.nativeNaturalMediaBatchCount || 0) + 1;
          }

          const blocked = readBlocked();
          let attachmentsSeen = 0;
          let removed = 0;
          for (const row of mediaRows) {
            const attachments = row.message.attachments;
            attachmentsSeen += attachments.length;
            const visible = attachments.filter((attachment) => !shouldHideAttachment(attachment, blocked));
            removed += attachments.length - visible.length;
            if (visible.length !== attachments.length) {
              row.message.attachments = visible;
              if (visible.length === 0) {
                row.message.useAttachmentGridLayout = false;
                row.message.useAttachmentUploadPreview = false;
              }
            }
          }

          if (removed > 0) {
            args[1] = JSON.stringify(rows);
            storage.nativeReplacementCount = (storage.nativeReplacementCount || 0) + removed;
          }
          storage.latestNativeReport = [
            `native update ${new Date().toISOString()}`,
            lastNativeInvocation,
            `rows=${rows.length}`,
            `mediaRows=${mediaRows.length}`,
            `attachmentsSeen=${attachmentsSeen}`,
            `hideAllAttachments=${!!storage.hideAllAttachments}`,
            `blockedKeys=${[...blocked].join(", ") || "<none>"}`,
            `nativeRemoved=${removed}`
          ].join("\n");
        } catch (error) {
          storage.nativePatchStatus = `DCDChatManager.updateRows filter failed: ${String(error)}`;
        }
      });

      storage.nativePatchStatus = "Active. Capturing original media batches and filtering serialized rows before the mounted iOS chat view.";
    } catch (error) {
      storage.nativePatchStatus = `DCDChatManager.updateRows patch failed: ${String(error)}`;
    }
  }

  function toggleRecent(item) {
    const blocked = readBlocked();
    const key = globalAttachmentKey(item.filename);
    if (blocked.has(key)) blocked.delete(key);
    else blocked.add(key);
    writeBlocked(blocked);
    requestMessageRefresh(item);
  }

  function requestMessageRefresh(targetHint) {
    installNativeRowsPatch();
    storage.refreshCount = (storage.refreshCount || 0) + 1;
    storage.refreshTarget = "<none>";
    storage.refreshMessageFound = false;
    storage.refreshNativeReplayed = false;
    storage.refreshDispatchError = "";

    try {
      const target = (targetHint &&
        typeof targetHint.channelId === "string" && targetHint.channelId &&
        typeof targetHint.messageId === "string" && targetHint.messageId
          ? targetHint
          : readRecent().find((item) =>
        typeof item?.channelId === "string" && item.channelId &&
        typeof item?.messageId === "string" && item.messageId
      ));
      if (!target) {
        storage.refreshStatus = "No captured media message is available for refresh.";
        return;
      }

      storage.refreshTarget = `${target.channelId}:${target.messageId}`;
      storage.latestMatchReport = [
        `refresh pending ${new Date().toISOString()}`,
        `refreshTarget=${storage.refreshTarget}`,
        `hideAllAttachments=${!!storage.hideAllAttachments}`,
        `blockedKeys=${[...readBlocked()].join(", ") || "<none>"}`,
        "Waiting for generateMessageRowData to rebuild this media row."
      ].join("\n");

      const messageStore = metro.findByStoreName?.("MessageStore") ?? findByProps(["getMessage", "getMessages"]);
      const freshMessage = messageStore?.getMessage?.(target.channelId, target.messageId);
      storage.refreshMessageFound = !!freshMessage;
      if (!freshMessage || !Array.isArray(freshMessage.attachments)) {
        storage.refreshStatus = "Newest captured media message is not present in MessageStore.";
        return;
      }

      const targetFilename = attachmentFilename(target);
      if (!targetFilename || !freshMessage.attachments.some((attachment) => attachmentFilename(attachment) === targetFilename)) {
        storage.refreshStatus = "Newest captured attachment no longer exists on the live MessageStore message.";
        return;
      }

      const dispatcher = metro.common?.FluxDispatcher ?? findByProps(["dispatch", "subscribe", "unsubscribe"]);
      if (typeof dispatcher?.dispatch !== "function") {
        storage.refreshStatus = "FluxDispatcher.dispatch is unavailable.";
        return;
      }

      const nativeReplayed = replayCapturedNativeRows(target);
      storage.refreshNativeReplayed = nativeReplayed;

      const updateMessage = cloneWithOverrides(freshMessage, {
        id: target.messageId,
        channel_id: target.channelId,
        attachments: freshMessage.attachments.slice()
      });
      storage.refreshStatus = `${nativeReplayed ? "Submitted one guarded native media-row update. " : ""}Queued one local MESSAGE_UPDATE for the newest captured media message.`;
      Promise.resolve()
        .then(() => dispatcher.dispatch({ type: "MESSAGE_UPDATE", message: updateMessage }))
        .then(
          () => {
            storage.refreshStatus = `${nativeReplayed ? "Submitted one guarded native media-row update and dispatched" : "Dispatched"} one local MESSAGE_UPDATE for the newest captured media message.`;
          },
          (error) => {
            storage.refreshDispatchError = String(error);
            storage.refreshStatus = `Local MESSAGE_UPDATE failed: ${String(error)}`;
          }
        );
    } catch (error) {
      storage.refreshDispatchError = String(error);
      storage.refreshStatus = `Local MESSAGE_UPDATE failed: ${String(error)}`;
    }
  }

  const styles = RN.StyleSheet.create({
    page: { flex: 1 },
    content: { padding: 16, paddingBottom: 40 },
    title: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 8 },
    note: { color: "rgba(255,255,255,.7)", fontSize: 13, lineHeight: 18, marginBottom: 12 },
    button: { backgroundColor: "#5865f2", paddingVertical: 11, paddingHorizontal: 14, borderRadius: 8, marginBottom: 10 },
    secondaryButton: { backgroundColor: "rgba(255,255,255,.10)" },
    buttonText: { color: "#fff", fontWeight: "700", textAlign: "center" },
    filename: { color: "#fff", fontSize: 13, marginBottom: 5 },
    state: { color: "rgba(255,255,255,.65)", fontSize: 11 }
  });

  function Settings() {
    const [, refresh] = React.useReducer((value) => value + 1, 0);
    const recent = readRecent();
    const blocked = readBlocked();

    return React.createElement(
      RN.ScrollView,
      { style: styles.page, contentContainerStyle: styles.content },
      React.createElement(RN.Text, { style: styles.title }, "Hide Media Everywhere"),
      React.createElement(
        RN.Text,
        { style: styles.note },
        `${storage.patchStatus || "Patch not installed"}\n${storage.nativePatchStatus || "Native row patch not installed."}\n${blocked.size} selected filename${blocked.size === 1 ? "" : "s"}. Row calls: ${storage.rowCallCount || 0}. Media rows: ${storage.mediaRowCount || 0}. Replaced attachments: ${storage.replacementCount || 0}. Native replacements: ${storage.nativeReplacementCount || 0}. Hide-all test: ${storage.hideAllAttachments ? "ON" : "OFF"}.\n${storage.refreshStatus || "No refresh requested yet."}`
      ),
      React.createElement(
        RN.Text,
        { style: styles.note },
        "Tap a filename to hide it. The hide-all test changes only completed row data and resets automatically after a full app restart."
      ),
      recent.length === 0
        ? React.createElement(RN.Text, { style: styles.note }, "No attachments captured yet.")
        : recent.map((item) => React.createElement(
            RN.Pressable,
            {
              key: item.key,
              style: styles.button,
              onPress: () => {
                toggleRecent(item);
                refresh();
              }
            },
            React.createElement(RN.Text, { style: styles.filename }, item.filename),
            React.createElement(RN.Text, { style: styles.state }, blocked.has(globalAttachmentKey(item.filename)) ? "Hidden. Tap to unhide" : "Visible. Tap to hide")
          )),
      React.createElement(
        RN.Pressable,
        {
          style: styles.button,
          onPress: () => {
            storage.hideAllAttachments = !storage.hideAllAttachments;
            requestMessageRefresh();
            refresh();
          }
        },
        React.createElement(
          RN.Text,
          { style: styles.buttonText },
          storage.hideAllAttachments ? "Stop hide-all test" : "Hide every attachment (test)"
        )
      ),
      React.createElement(
        RN.Pressable,
        {
          style: [styles.button, styles.secondaryButton],
          onPress: () => {
            const menuReport = "Skipped in the focused row-refresh build.";
            RN.Clipboard.setString([
              `HideMediaEverywhere 1.5.0`,
              `Known-good renderer baseline: 487003a`,
              `Row calls: ${storage.rowCallCount || 0}`,
              `Media rows: ${storage.mediaRowCount || 0}`,
              `Replaced attachments: ${storage.replacementCount || 0}`,
              `Native row patch: ${storage.nativePatchStatus || "not installed"}`,
              `Native clearRows guard: ${storage.nativeClearRowsGuardStatus || "not installed"}`,
              `Native updateRows calls: ${nativeUpdateRowsCalls}`,
              `Native clearRows calls: ${nativeClearRowsCalls}`,
              `Last native invocation: ${lastNativeInvocation}`,
              `Native media batches: ${storage.nativeMediaBatchCount || 0}`,
              `Natural native media batches: ${storage.nativeNaturalMediaBatchCount || 0}`,
              `Replay native media batches: ${storage.nativeReplayMediaBatchCount || 0}`,
              `Native replaced attachments: ${storage.nativeReplacementCount || 0}`,
              `Native captures in memory: ${nativeMediaCaptures.length}`,
              `Native replay attempts: ${nativeReplayAttempts}`,
              `Native replay submissions: ${nativeReplaySubmissions}`,
              `Native capture invalidations: ${nativeCaptureInvalidations}`,
              `Last native capture: ${lastNativeCapture}`,
              `Last native replay: ${lastNativeReplay}`,
              `Last native invalidation: ${lastNativeInvalidation}`,
              `Hide-all test: ${storage.hideAllAttachments ? "ON" : "OFF"}`,
              `Refresh target: ${storage.refreshTarget || "<none>"}`,
              `Fresh message found: ${storage.refreshMessageFound ? "yes" : "no"}`,
              storage.refreshStatus || "No refresh requested yet.",
              `Refresh dispatch error: ${storage.refreshDispatchError || "<none>"}`,
              storage.latestMatchReport || "No media match report yet.",
              storage.latestNativeReport || "No native media-row report yet.",
              "",
              "Native menu discovery:",
              menuReport
            ].join("\n"));
          }
        },
        React.createElement(RN.Text, { style: styles.buttonText }, "Copy complete report")
      ),
      React.createElement(
        RN.Pressable,
        {
          style: [styles.button, styles.secondaryButton],
          onPress: () => {
            writeBlocked(new Set());
            requestMessageRefresh();
            refresh();
          }
        },
        React.createElement(RN.Text, { style: styles.buttonText }, "Unhide all")
      )
    );
  }

  return {
    onLoad() {
      nativeUpdateRowsCalls = 0;
      nativeClearRowsCalls = 0;
      lastNativeInvocation = "No DCDChatManager.updateRows call captured yet.";
      nativeMediaCaptures = [];
      latestNativeArgsByTag = new Map();
      replayingNativeRows = false;
      nativeReplayAttempts = 0;
      nativeReplaySubmissions = 0;
      nativeCaptureInvalidations = 0;
      nativeClearRowsGuardActive = false;
      lastNativeCapture = "No native media batch captured yet.";
      lastNativeReplay = "No native media replay attempted yet.";
      lastNativeInvalidation = "No native media capture invalidated yet.";
      storage.hideAllAttachments = false;
      storage.replacementCount = 0;
      storage.nativeMediaBatchCount = 0;
      storage.nativeNaturalMediaBatchCount = 0;
      storage.nativeReplayMediaBatchCount = 0;
      storage.nativeReplacementCount = 0;
      installPatch();
      installNativeRowsPatch();
    },
    onUnload() {
      try {
        unpatchRowData?.();
      } finally {
        unpatchRowData = null;
        try {
          unpatchNativeRows?.();
        } finally {
          unpatchNativeRows = null;
          try {
            unpatchNativeClearRows?.();
          } finally {
            unpatchNativeClearRows = null;
            nativeClearRowsGuardActive = false;
            nativeMediaCaptures = [];
            latestNativeArgsByTag = new Map();
          }
        }
      }
    },
    settings: Settings
  };
})()
