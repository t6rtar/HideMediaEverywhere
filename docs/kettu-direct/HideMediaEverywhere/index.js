(() => {
  const metro = vendetta.metro;
  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const storage = vendetta.plugin.storage;
  const logger = vendetta.logger;
  let unpatchRowData = null;
  let unpatchActionSheets = [];
  let unpatchSheetRenderers = [];
  let patchedSheetModules = new WeakSet();

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

  function findAllByProps(props) {
    if (typeof metro.findByPropsAll === "function") {
      try {
        const matches = metro.findByPropsAll(...props);
        if (Array.isArray(matches)) return matches.filter(Boolean);
      } catch { }
    }
    const match = findByProps(props);
    return match ? [match] : [];
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

  function isGifAttachment(attachment) {
    const filename = attachmentFilename(attachment).toLowerCase();
    const contentType = String(attachment?.content_type || attachment?.original_content_type || "").toLowerCase();
    const urls = [attachment?.url, attachment?.proxy_url, attachment?.videoUrl].filter((value) => typeof value === "string");
    return attachment?.srcIsAnimated === true
      || contentType === "image/gif"
      || filename.endsWith(".gif")
      || urls.some((url) => /(?:tenor|giphy)\.com/i.test(url));
  }

  function attachmentBlockKey(authorId, attachment) {
    const filename = attachmentFilename(attachment);
    if (!filename) return "";
    return isGifAttachment(attachment) ? globalAttachmentKey(filename) : attachmentKey(authorId, filename);
  }

  function readBlocked() {
    return new Set(
      String(storage.blockedKeys || "")
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
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
      const key = attachmentBlockKey(authorId, attachment);
      const oldIndex = recent.findIndex((item) => item.key === key);
      if (oldIndex !== -1) recent.splice(oldIndex, 1);
      recent.unshift({ key, filename, authorId, kind: isGifAttachment(attachment) ? "gif" : "media" });
    }
    storage.recentAttachments = JSON.stringify(recent.slice(0, 30));
  }

  function attachmentMatchLines(label, attachments, blocked, authorId) {
    if (!Array.isArray(attachments)) return [`${label}: not an array`];
    if (attachments.length === 0) return [`${label}: empty`];
    return attachments.map((attachment, index) => {
      const filename = attachmentFilename(attachment) || "<no filename>";
      const key = filename === "<no filename>" ? "<none>" : attachmentBlockKey(authorId, attachment);
      return `${label}[${index}]: filename=${filename} key=${key} selected=${blocked.has(key)}`;
    });
  }

  function findMessagePaths(value, path, depth, seen, output) {
    if (!value || depth > 4 || (typeof value !== "object" && typeof value !== "function")) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (!Array.isArray(value) && (Array.isArray(value.attachments) || Array.isArray(value.embeds))) {
      output.push(
        `${path}: attachments=${Array.isArray(value.attachments) ? value.attachments.length : "n/a"} embeds=${Array.isArray(value.embeds) ? value.embeds.length : "n/a"} keys=${keysOf(value).slice(0, 30).join(",")}`
      );
    }

    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(value.length, 12); index++) {
        findMessagePaths(value[index], `${path}[${index}]`, depth + 1, seen, output);
      }
      return;
    }

    for (const key of keysOf(value).slice(0, 60)) {
      let child;
      try {
        child = value[key];
      } catch {
        continue;
      }
      findMessagePaths(child, `${path}.${key}`, depth + 1, seen, output);
      if (output.length >= 30) return;
    }
  }

  function describeActionSheet(method, args) {
    const config = args?.[0];
    const options = Array.isArray(config?.options) ? config.options : [];
    const messagePaths = [];
    findMessagePaths(args, "args", 0, new Set(), messagePaths);
    return [
      `action sheet ${new Date().toISOString()}`,
      `method=${method}`,
      `argCount=${Array.isArray(args) ? args.length : "n/a"}`,
      ...Array.from({ length: Math.min(args?.length || 0, 5) }, (_, index) =>
        `arg[${index}]: type=${Array.isArray(args[index]) ? "array" : typeof args[index]} value=${typeof args[index] === "string" ? args[index] : "<non-string>"} keys=${keysOf(args[index]).slice(0, 60).join(",") || "<none>"}`
      ),
      `key=${typeof config?.key === "string" ? config.key : "<none>"}`,
      `configKeys=${keysOf(config).join(", ") || "<none>"}`,
      `headerKeys=${keysOf(config?.header).join(", ") || "<none>"}`,
      `optionCount=${options.length}`,
      ...options.slice(0, 30).map((option, index) => `option[${index}]: label=${String(option?.label ?? "<none>")} keys=${keysOf(option).join(",")}`),
      "message-like paths:",
      ...(messagePaths.length ? messagePaths : ["<none>"])
    ].join("\n");
  }

  function saveActionSheetCapture(method, args) {
    const captures = (() => {
      try {
        const parsed = JSON.parse(storage.actionSheetReports || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    captures.unshift(describeActionSheet(method, args));
    storage.actionSheetReports = JSON.stringify(captures.slice(0, 8));
    storage.actionSheetCaptureCount = (storage.actionSheetCaptureCount || 0) + 1;
  }

  function readActionSheetReports() {
    try {
      const parsed = JSON.parse(storage.actionSheetReports || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function elementTypeName(type) {
    if (typeof type === "string") return type;
    if (typeof type === "function") return type.displayName || type.name || "anonymous function";
    if (typeof type === "symbol") return String(type);
    if (type && typeof type === "object") {
      return type.displayName || type.name || type.render?.displayName || type.render?.name || `object(${keysOf(type).join(",")})`;
    }
    return String(type);
  }

  function describeElementTree(root) {
    const lines = [];
    const seen = new Set();
    function walk(node, path, depth) {
      if (lines.length >= 180 || depth > 9 || node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) {
        lines.push(`${path}: array(${node.length})`);
        for (let index = 0; index < Math.min(node.length, 40); index++) walk(node[index], `${path}[${index}]`, depth + 1);
        return;
      }
      if (typeof node !== "object") {
        lines.push(`${path}: ${typeof node}=${String(node).slice(0, 100)}`);
        return;
      }
      if (seen.has(node)) {
        lines.push(`${path}: <seen>`);
        return;
      }
      seen.add(node);
      const props = node.props;
      const summaries = ["label", "title", "text", "name"].flatMap((key) => {
        const value = props?.[key];
        return typeof value === "string" ? [`${key}=${JSON.stringify(value.slice(0, 100))}`] : [];
      });
      lines.push(`${path}: type=${elementTypeName(node.type)} keys=${keysOf(node).join(",") || "<none>"} props=${keysOf(props).slice(0, 80).join(",") || "<none>"}${summaries.length ? ` ${summaries.join(" ")}` : ""}`);
      if (props && Object.prototype.hasOwnProperty.call(props, "children")) walk(props.children, `${path}.children`, depth + 1);
    }
    walk(root, "result", 0);
    return lines.join("\n") || "<empty render result>";
  }

  function patchMessageSheetImporter(args) {
    if (args?.[1] !== "MessageLongPressActionSheet") return;
    const importer = args[0];
    args[0] = Promise.resolve(importer).then((module) => {
      try {
        storage.messageSheetModuleReport = [
          `resolved ${new Date().toISOString()}`,
          `moduleType=${typeof module}`,
          `moduleKeys=${keysOf(module).join(",") || "<none>"}`,
          `defaultType=${typeof module?.default}`,
          `defaultKeys=${keysOf(module?.default).join(",") || "<none>"}`,
          `defaultName=${elementTypeName(module?.default)}`
        ].join("\n");
        if (!module || (typeof module !== "object" && typeof module !== "function") || patchedSheetModules.has(module)) return module;
        patchedSheetModules.add(module);
        let target = module;
        let method = "default";
        if (typeof module.default !== "function" && typeof module.default?.render === "function") {
          target = module.default;
          method = "render";
        }
        if (typeof target?.[method] !== "function") {
          storage.messageSheetRenderStatus = `No patchable renderer. ${method} is ${typeof target?.[method]}.`;
          return module;
        }
        unpatchSheetRenderers.push(vendetta.patcher.after(method, target, (_renderArgs, result) => {
          try {
            storage.messageSheetRenderCount = (storage.messageSheetRenderCount || 0) + 1;
            storage.messageSheetRenderReport = describeElementTree(result);
          } catch (error) {
            storage.messageSheetRenderStatus = `Render capture error: ${String(error)}`;
          }
        }));
        storage.messageSheetRenderStatus = `Observing resolved ${method} renderer without changing it.`;
      } catch (error) {
        storage.messageSheetRenderStatus = `Renderer patch error: ${String(error)}`;
      }
      return module;
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

  function shouldHideAttachment(attachment, blocked, authorId) {
    if (storage.hideAllAttachments) return true;
    const key = attachmentBlockKey(authorId, attachment);
    return !!key && blocked.has(key);
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
        const authorId = authorIdFrom(sourceMessage);
        rememberAttachments(sourceMessage, sourceMessage?.attachments);
        const sourceAttachments = sourceMessage?.attachments;
        if (Array.isArray(sourceAttachments) && sourceAttachments.length > 0) {
          storage.mediaRowCount = (storage.mediaRowCount || 0) + 1;
          storage.latestMatchReport = [
            `match ${new Date().toISOString()}`,
            "postGenerationReplacement=true",
            `blockedKeys=${[...blocked].join(", ") || "<none>"}`,
            ...attachmentMatchLines("source", sourceAttachments, blocked, authorId)
          ].join("\n");
        }
        const rowAttachments = result?.message?.attachments;
        rememberAttachments(sourceMessage, rowAttachments);
        if (Array.isArray(rowAttachments) && rowAttachments.length > 0) {
          const visible = rowAttachments.filter((attachment) => !shouldHideAttachment(attachment, blocked, authorId));
          const removed = rowAttachments.length - visible.length;
          storage.latestMatchReport = [
            storage.latestMatchReport || `match ${new Date().toISOString()}`,
            ...attachmentMatchLines("result", rowAttachments, blocked || new Set(), authorId),
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

  function installActionSheetProbe() {
    if (typeof vendetta.patcher?.before !== "function") {
      storage.actionSheetProbeStatus = `patcher.before unavailable. Keys: ${keysOf(vendetta.patcher).join(", ") || "<none>"}`;
      return;
    }

    const targetGroups = [
      [findAllByProps(["showSimpleActionSheet"]), "showSimpleActionSheet"],
      [findAllByProps(["openLazy", "hideActionSheet"]), "openLazy"]
    ];
    const targets = [];
    const seenTargets = new Set();
    for (const [modules, method] of targetGroups) {
      for (const module of modules) {
        if (!module || typeof module[method] !== "function") continue;
        const identity = module[method];
        if (seenTargets.has(identity)) continue;
        seenTargets.add(identity);
        targets.push([module, method]);
      }
    }
    const installed = [];
    for (const [module, method] of targets) {
      if (!module || typeof module[method] !== "function") continue;
      try {
        unpatchActionSheets.push(vendetta.patcher.before(method, module, (args) => {
          try {
            saveActionSheetCapture(method, args);
            if (method === "openLazy") patchMessageSheetImporter(args);
          } catch (error) {
            storage.actionSheetProbeError = `${method} capture error: ${String(error)}`;
          }
        }));
        installed.push(`${method}#${installed.filter((name) => name.startsWith(method)).length + 1}`);
      } catch (error) {
        storage.actionSheetProbeError = `${method} patch error: ${String(error)}`;
      }
    }
    storage.actionSheetProbeStatus = installed.length
      ? `Observing ${installed.join(" + ")} without changing them. Candidates: simple=${targetGroups[0][0].length}, lazy=${targetGroups[1][0].length}.`
      : "No compatible action-sheet entry point was found.";
  }

  function toggleRecent(item) {
    const blocked = readBlocked();
    const key = item.key;
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
            React.createElement(RN.Text, { style: styles.state }, blocked.has(item.key) ? "Hidden. Tap to unhide" : "Visible. Tap to hide")
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
          onPress: () => RN.Clipboard.setString([
            `HideMediaEverywhere 0.8.0`,
            `Row calls: ${storage.rowCallCount || 0}`,
            `Media rows: ${storage.mediaRowCount || 0}`,
            `Replaced attachments: ${storage.replacementCount || 0}`,
            `Hide-all test: ${storage.hideAllAttachments ? "ON" : "OFF"}`,
            storage.refreshStatus || "No refresh requested yet.",
            storage.latestMatchReport || "No media match report yet.",
            "",
            "Action-sheet probe:",
            storage.actionSheetProbeStatus || "Probe not installed.",
            `Captures: ${storage.actionSheetCaptureCount || 0}`,
            storage.actionSheetProbeError || "No action-sheet probe errors.",
            ...(readActionSheetReports().length
              ? readActionSheetReports().flatMap((report, index) => ["", `Capture ${index + 1}:`, report])
              : ["No action sheet captured yet."]),
            "",
            "Message sheet renderer:",
            storage.messageSheetRenderStatus || "Renderer probe not installed yet.",
            `Render captures: ${storage.messageSheetRenderCount || 0}`,
            storage.messageSheetModuleReport || "No message-sheet module resolved yet.",
            storage.messageSheetRenderReport || "No message-sheet render captured yet."
          ].join("\n"))
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
      storage.actionSheetCaptureCount = 0;
      storage.actionSheetReports = "[]";
      storage.actionSheetProbeError = "";
      storage.messageSheetRenderCount = 0;
      storage.messageSheetModuleReport = "";
      storage.messageSheetRenderReport = "";
      storage.messageSheetRenderStatus = "";
      installPatch();
      installActionSheetProbe();
    },
    onUnload() {
      try {
        unpatchRowData?.();
        for (const unpatch of unpatchActionSheets) unpatch?.();
        for (const unpatch of unpatchSheetRenderers) unpatch?.();
      } finally {
        unpatchRowData = null;
        unpatchActionSheets = [];
        unpatchSheetRenderers = [];
        patchedSheetModules = new WeakSet();
      }
    },
    settings: Settings
  };
})()
