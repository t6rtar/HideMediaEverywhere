(() => {
  const metro = vendetta.metro;
  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const storage = vendetta.plugin.storage;
  const logger = vendetta.logger;
  let unpatchRowData = null;

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
    const recent = readRecent();
    for (const attachment of attachments) {
      const filename = attachmentFilename(attachment);
      if (!filename) continue;
      const key = attachmentKey(authorId, filename);
      const oldIndex = recent.findIndex((item) => item.key === key);
      if (oldIndex !== -1) recent.splice(oldIndex, 1);
      recent.unshift({ key, filename, authorId });
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

  function toggleRecent(item) {
    const blocked = readBlocked();
    const key = globalAttachmentKey(item.filename);
    if (blocked.has(key)) blocked.delete(key);
    else blocked.add(key);
    writeBlocked(blocked);
    requestMessageRefresh();
  }

  function requestMessageRefresh() {
    try {
      const messageStore = findByProps(["getMessage", "getMessages"]);
      if (typeof messageStore?.emitChange === "function") {
        messageStore.emitChange();
        storage.refreshStatus = "Requested a message-store refresh with emitChange.";
      } else if (typeof messageStore?.doEmitChanges === "function") {
        messageStore.doEmitChanges();
        storage.refreshStatus = "Requested a message-store refresh with doEmitChanges.";
      } else {
        storage.refreshStatus = "Message-store refresh method was unavailable.";
      }
      storage.refreshCount = (storage.refreshCount || 0) + 1;
    } catch (error) {
      storage.refreshStatus = `Message-store refresh failed: ${String(error)}`;
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
        `${storage.patchStatus || "Patch not installed"}\n${blocked.size} selected filename${blocked.size === 1 ? "" : "s"}. Row calls: ${storage.rowCallCount || 0}. Media rows: ${storage.mediaRowCount || 0}. Replaced attachments: ${storage.replacementCount || 0}. Hide-all test: ${storage.hideAllAttachments ? "ON" : "OFF"}.\n${storage.refreshStatus || "No refresh requested yet."}`
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
            const menuReport = scanMenuModules();
            RN.Clipboard.setString([
              `HideMediaEverywhere 0.9.0`,
              `Known-good renderer baseline: 487003a`,
              `Row calls: ${storage.rowCallCount || 0}`,
              `Media rows: ${storage.mediaRowCount || 0}`,
              `Replaced attachments: ${storage.replacementCount || 0}`,
              `Hide-all test: ${storage.hideAllAttachments ? "ON" : "OFF"}`,
              storage.refreshStatus || "No refresh requested yet.",
              storage.latestMatchReport || "No media match report yet.",
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
      storage.hideAllAttachments = false;
      storage.replacementCount = 0;
      installPatch();
    },
    onUnload() {
      try {
        unpatchRowData?.();
      } finally {
        unpatchRowData = null;
      }
    },
    settings: Settings
  };
})()
