"use strict";

const configNames = { Guns: "gun.json", Mags: "mag.json", Rounds: "round.json" };
const audioFormats = [".wav", ".ogg", ".mp3", ".aiff", ".aif", ".mod", ".it", ".s3m", ".xm"];
const jsonTokens = /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|,(?=\s*[}\]])/g;
const objectKeyEnd = /^(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*:/;
const encoder = new TextEncoder();
const extension = name => /(?:[^/])(\.[^./]*)$/.exec(name)?.[1]?.toLowerCase() || "";
const isMissing = error => ["NotFoundError", "TypeMismatchError"].includes(error.name);
const missingFile = () => new DOMException("File or folder not found.", "NotFoundError");

function pathParts(path) {
    const parts = path ? path.split("/") : [];
    if (parts.some(part => !part || part === "." || part === ".." || /[\\:\0]/.test(part)))
        throw new Error("Use a relative path inside the selected folder.");
    return parts;
}

class DiskFolder {
    constructor(handle) { this.handle = handle; this.name = handle.name; this.onDisk = true; }

    async directory(path, create = false) {
        let handle = this.handle;
        for (const part of pathParts(path)) handle = await handle.getDirectoryHandle(part, { create });
        return handle;
    }

    async file(path, create = false) {
        const parts = pathParts(path);
        const name = parts.pop();
        const parent = await this.directory(parts.join("/"), create);
        return parent.getFileHandle(name, { create });
    }

    async read(path) { return (await this.file(path)).getFile(); }

    async write(path, contents) {
        const stream = await (await this.file(path, true)).createWritable();
        try {
            await stream.write(contents);
            await stream.close();
        } catch (error) {
            await stream.abort().catch(() => {});
            throw error;
        }
    }

    async list(path) {
        const entries = [];
        for await (const [name, handle] of await this.directory(path)) entries.push({ name, kind: handle.kind });
        return entries;
    }

    async remove(path, recursive = false) {
        const parts = pathParts(path);
        const name = parts.pop();
        const parent = await this.directory(parts.join("/"));
        await parent.removeEntry(name, { recursive });
    }
}

class ImportedFolder {
    constructor(files) {
        this.files = new Map();
        this.onDisk = false;
        const firstPath = files[0]?.webkitRelativePath;
        if (!firstPath) throw new Error("Choose a folder, not individual files.");
        this.name = firstPath.split("/")[0];
        for (const file of files) {
            const [root, ...parts] = pathParts(file.webkitRelativePath);
            if (root !== this.name || !parts.length) throw new Error("Choose one folder at a time.");
            this.files.set(parts.join("/"), file);
        }
    }

    async read(path) {
        pathParts(path);
        if (!this.files.has(path)) throw missingFile();
        return this.files.get(path);
    }

    async write(path, contents) {
        pathParts(path);
        this.files.set(path, contents instanceof File ? contents : new File([contents], path.split("/").pop()));
    }

    async list(path) {
        pathParts(path);
        const prefix = path ? path + "/" : "";
        const entries = new Map();
        for (const item of this.files.keys()) {
            if (!item.startsWith(prefix)) continue;
            const [name, child] = item.slice(prefix.length).split("/");
            entries.set(name, child === undefined ? "file" : "directory");
        }
        if (path && !entries.size) throw missingFile();
        return [...entries].map(([name, kind]) => ({ name, kind }));
    }

    async remove(path, recursive = false) {
        pathParts(path);
        if (this.files.delete(path)) return;
        if (recursive) {
            const descendants = [...this.files.keys()].filter(name => name.startsWith(path + "/"));
            if (descendants.length) {
                descendants.forEach(name => this.files.delete(name));
                return;
            }
        }
        throw missingFile();
    }
}

function decodeConfig(raw) {
    const clean = raw.replace(jsonTokens, token => token[0] === '"' || token === "," ? token : " ")
        .replace(jsonTokens, token => token === "," ? "" : token);
    const data = JSON.parse(clean);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The config must be a JSON object.");
    return data;
}

async function digest(contents) {
    const buffer = typeof contents === "string" ? encoder.encode(contents) : await contents.arrayBuffer();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
    return Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
}

function configPath(kind, id) {
    if (!Object.hasOwn(configNames, kind) || !/^[\p{L}\p{N}_.-]+$/u.test(id) || id === "." || id === "..")
        throw new Error("Invalid item category or ID.");
    return kind + "/" + id + "/" + configNames[kind];
}

function assetPaths(entry, name, audio) {
    if (!name) return [];
    const shared = !audio && name.startsWith("COPY__");
    const relative = shared ? name.slice(6) : name;
    pathParts(relative);
    const base = shared ? relative : entry.kind + "/" + entry.id + "/" + relative;
    const suffix = extension(relative);
    if (!audio) return [suffix === ".png" ? base : base + ".png"];
    return suffix ? (audioFormats.includes(suffix) ? [base] : []) : audioFormats.map(ext => base + ext);
}

function syncAmmoVisuals(old, data) {
    if (!Object.hasOwn(old, "minigame")) { delete data.minigame; return; }
    const game = data.minigame = old.minigame;
    const { ammoTypes: before } = old, { ammoTypes: after } = data;
    if (!game || typeof game !== "object" || !Array.isArray(before) || !Array.isArray(after) || before.length === after.length) return;
    const positions = new Map(before.map((ammo, index) => [ammo?.round, index]));
    const indexes = after.map(ammo => positions.get(ammo?.round));
    const remap = (paths, offset = 0) => paths.slice(0, offset).concat(indexes.map(index =>
        index === undefined ? null : paths[index + offset] ?? null));
    for (const [field, offset] of [["ammosInHandPaths", 0], ["ammosInPtrPaths", 0], ["casingsPath", 1]]) {
        if (Array.isArray(game[field]) && game[field].length) game[field] = remap(game[field], offset);
    }
    for (const [id, paths] of Object.entries(game.ammosInMagazinePaths || {})) {
        if (Array.isArray(paths)) game.ammosInMagazinePaths[id] = remap(paths);
    }
    if (Array.isArray(game.ammos)) game.ammos = after.map(ammo => ammo?.round ?? null);
    if (Number.isInteger(game.dCurrentAmmo)) game.dCurrentAmmo = Math.min(game.dCurrentAmmo, Math.max(0, after.length - 1));
}

class Workspace {
    constructor(folder) {
        this.folder = folder;
        this.name = folder.name;
        this.onDisk = folder.onDisk;
        this.operations = Promise.resolve();
        this.modified = false;
    }

    mutate(action) {
        const result = this.operations.then(action);
        this.operations = result.catch(() => {});
        return result.then(value => { this.modified = true; return value; });
    }

    async optionalFile(path) {
        try { return await this.folder.read(path); }
        catch (error) { if (!isMissing(error)) throw error; return null; }
    }

    async *files(path = "") {
        const entries = await this.folder.list(path);
        for (const entry of entries) {
            const child = path ? path + "/" + entry.name : entry.name;
            if (entry.kind === "directory") yield* this.files(child);
            else yield child;
        }
    }

    async *configs() {
        for (const kind of Object.keys(configNames)) {
            let entries;
            try { entries = await this.folder.list(kind); }
            catch (error) { if (!isMissing(error)) throw error; continue; }
            for (const { name: id, kind: type } of entries.sort((left, right) => left.name.localeCompare(right.name))) {
                if (type !== "directory" || !/^[\p{L}\p{N}_.-]+$/u.test(id)) continue;
                const entry = { kind, id };
                const path = configPath(kind, id);
                const file = await this.optionalFile(path);
                if (file) yield { entry, path, file };
            }
        }
    }

    async catalog() {
        const entries = [];
        const root = await this.folder.list("");
        if (!root.some(entry => entry.kind === "directory" && Object.hasOwn(configNames, entry.name)))
            throw new Error("Choose the mod folder that contains Guns, Mags, and Rounds.");
        for await (const { entry, file } of this.configs()) {
            try { entry.data = decodeConfig(await file.text()); }
            catch (error) { entry.error = error.message; }
            entries.push(entry);
        }
        return { entries, schema: editorSchema };
    }

    async readItem(entry) {
        const file = await this.folder.read(configPath(entry.kind, entry.id));
        return { data: decodeConfig(await file.text()), revision: await digest(file) };
    }

    async checkRevision(path, revision) {
        const file = await this.folder.read(path);
        if (await digest(file) !== revision) throw new Error("The file changed on disk. Reload it first.");
        return file;
    }

    async backup(path, file) {
        if (!await this.optionalFile(path + ".editor.bak")) await this.folder.write(path + ".editor.bak", file);
    }

    async findAsset(entry, name, audio = false) {
        for (const path of assetPaths(entry, name, audio)) {
            const file = await this.optionalFile(path);
            if (file) return { path, file };
        }
        return null;
    }

    async movePlan(entry, old, name, audio) {
        if (!old || !name || old.startsWith("COPY__") || name.startsWith("COPY__")) return null;
        const source = await this.findAsset(entry, old, audio);
        if (!source || (entry.kind !== "Guns" && source.path === entry.kind + "/" + entry.id + "/item.png")) return null;
        const target = assetPaths(entry, name, audio).find(path => extension(path) === extension(source.path));
        return target && !await this.findAsset(entry, name, audio) ? { ...source, target } : null;
    }

    async assetStatus(entry, old, name, audio) {
        const exists = Boolean(await this.findAsset(entry, name, audio));
        return { exists, canMove: !exists && Boolean(await this.movePlan(entry, old, name, audio)) };
    }

    saveItem(entry, { data, revision, assetMove }) {
        return this.mutate(async () => {
            const path = configPath(entry.kind, entry.id);
            const original = await this.checkRevision(path, revision);
            syncAmmoVisuals(decodeConfig(await original.text()), data);
            const contents = JSON.stringify(data, null, 4) + "\n";
            await this.backup(path, original);
            const plan = assetMove && await this.movePlan(entry, assetMove.old, assetMove.name, assetMove.audio);
            if (assetMove && !plan) throw new Error("The resource could not be moved. Check both paths.");
            if (!plan) await this.folder.write(path, contents);
            else {
                const previous = await original.arrayBuffer();
                await this.folder.write(plan.target, plan.file);
                try {
                    await this.folder.write(path, contents);
                    await this.folder.remove(plan.path);
                } catch (error) {
                    await this.folder.write(path, previous);
                    await this.folder.remove(plan.target);
                    throw error;
                }
            }
            return { revision: await digest(contents) };
        });
    }

    importAsset(entry, file, audio, icon) {
        return this.mutate(async () => {
            const ext = extension(file.name);
            if (!(audio ? audioFormats : [".png"]).includes(ext) || !file.size || file.size > 24 * 1024 * 1024)
                throw new Error("Unsupported file type or size (maximum 24 MB).");
            if (!audio) {
                const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
                if (String(signature) !== "137,80,78,71,13,10,26,10") throw new Error("The file is not a PNG.");
            }
            const prefix = entry.kind + "/" + entry.id + "/";
            let name;
            if (icon && entry.kind !== "Guns") {
                name = "item.png";
                const original = await this.optionalFile(prefix + name);
                if (original) await this.backup(prefix + name, original);
            } else {
                const stem = file.name.slice(0, -ext.length).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "asset";
                name = "editor-assets/" + stem + "-" + (await digest(file)).slice(0, 12) + ext;
            }
            await this.folder.write(prefix + name, file);
            return { name: audio ? name : name.slice(0, -4) };
        });
    }

    create({ kind, id, template, name }) {
        return this.mutate(async () => {
            const path = configPath(kind, id);
            const target = kind + "/" + id;
            const source = kind + "/" + template;
            const { data } = await this.readItem({ kind, id: template });
            if ((await this.folder.list(kind)).some(entry => entry.name.toLowerCase() === id.toLowerCase()))
                throw new Error("An item with this ID already exists.");
            const contents = JSON.stringify({ ...data, fullName: name }, null, 4) + "\n";
            try {
                for await (const file of this.files(source)) {
                    if ([".png", ...audioFormats].includes(extension(file)))
                        await this.folder.write(target + file.slice(source.length), await this.folder.read(file));
                }
                await this.folder.write(path, contents);
            } catch (error) {
                await this.folder.remove(target, true).catch(() => {});
                throw error;
            }
            return { data: { ...data, fullName: name }, revision: await digest(contents) };
        });
    }

    deleteGun(entry, revision) {
        return this.mutate(async () => {
            if (entry.kind !== "Guns") throw new Error("Only weapons can be deleted.");
            await this.checkRevision(configPath(entry.kind, entry.id), revision);
            const source = "Guns/" + entry.id;
            const prefix = "COPY__" + source + "/";
            const archive = ".editor-trash/" + entry.id + "-" + crypto.randomUUID() + "/" + entry.id;
            const changes = [], copies = new Map(), assets = new Map(), archived = new Map();
            for await (const config of this.configs()) {
                if (config.entry.kind === entry.kind && config.entry.id === entry.id) continue;
                const raw = await config.file.text();
                const needed = new Set();
                const visit = (token, offset) => {
                    if (token[0] !== '"' || objectKeyEnd.test(raw.slice(offset + token.length))) return null;
                    const value = JSON.parse(token);
                    return value.startsWith(prefix) ? value.slice(prefix.length) : null;
                };
                raw.replace(jsonTokens, (token, offset) => {
                    const relative = visit(token, offset);
                    if (relative !== null) needed.add(relative);
                    return token;
                });
                if (!needed.size) continue;
                for (const name of needed) {
                    pathParts(name);
                    if (!name) throw new Error("Invalid COPY__ reference in " + config.path);
                    if (!assets.has(name)) {
                        const file = await this.optionalFile(source + "/" + name + ".png");
                        if (!file) throw new Error("Missing COPY__ sprite: " + prefix + name + " (in " + config.path + ").");
                        const stem = name.split("/").pop().replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "sprite";
                        assets.set(name, { file, relative: "editor-assets/recovered/" + entry.id + "/" + stem + "-" + (await digest(file)).slice(0, 16) });
                    }
                    const asset = assets.get(name);
                    copies.set(config.path.slice(0, config.path.lastIndexOf("/") + 1) + asset.relative + ".png", asset.file);
                }
                const updated = raw.replace(jsonTokens, (token, offset) => {
                    const name = visit(token, offset);
                    return name === null ? token : JSON.stringify(assets.get(name).relative);
                });
                changes.push({ ...config, original: await config.file.arrayBuffer(), updated, data: decodeConfig(updated) });
            }
            for await (const path of this.files(source)) archived.set(path, await this.folder.read(path));
            const undo = [];
            try {
                for (const [path, file] of archived) {
                    const destination = archive + path.slice(source.length);
                    await this.folder.write(destination, file);
                    undo.push(() => this.folder.remove(destination));
                }
                for (const [path, file] of copies) {
                    const existing = await this.optionalFile(path);
                    if (existing) {
                        if (await digest(existing) !== await digest(file)) throw new Error("Recovery asset already exists: " + path);
                        continue;
                    }
                    await this.folder.write(path, file);
                    undo.push(() => this.folder.remove(path));
                }
                for (const change of changes) {
                    await this.checkRevision(change.path, await digest(change.file));
                    await this.backup(change.path, change.file);
                    await this.folder.write(change.path, change.updated);
                    undo.push(() => this.folder.write(change.path, change.original));
                }
            } catch (error) {
                for (const rollback of undo.reverse()) await rollback().catch(() => {});
                throw error;
            }
            try { await this.folder.remove(source, true); }
            catch (error) {
                for (const [path, file] of archived) {
                    const backup = await this.folder.read(archive + path.slice(source.length));
                    await this.folder.write(path, backup);
                }
                throw error;
            }
            return { updated: changes.map(({ entry, data }) => ({ ...entry, data })), archive };
        });
    }
}
