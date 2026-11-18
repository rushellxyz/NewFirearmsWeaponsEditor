"use strict";

const byId = id => document.getElementById(id);
const kinds = { Guns: "Weapons", Mags: "Magazines", Rounds: "Ammunition" };
const tabs = ["General", "Settings", "Assets"];
const ammoTab = "Ammunition";
const basic = new Set(["fullName", "description", "category", "slotRotation", "weight", "value", "recognition", "milkyCanSell", "itemSpriteXOffset", "itemSpriteYOffset", "ppu"]);
const spriteLists = new Set(["fireModesSpritePath", "bulletsSpritesPath"]);
const feed = ["Magazine", "Tube", "Barrel", "Revolver", "Battery"];
const magKinds = ["Regular", "Pseudo", "Battery"];
const audioExtensions = ".wav,.ogg,.mp3,.aiff,.aif,.mod,.it,.s3m,.xm";
const labels = {
    fullName: "Name", description: "Description", category: "Category",
    slotRotation: "Slot rotation", weight: "Weight", value: "Value", recognition: "Recognition",
    milkyCanSell: "Sold by Milky", itemSpriteXOffset: "Hand offset X",
    itemSpriteYOffset: "Hand offset Y", ppu: "Pixels per unit",
    ammoTypes: "Compatible rounds", magazineType: "Compatible magazine types",
    magazineTexturesPath: "Magazine layers", capacity: "Capacity",
    feedType: "Feed type", fireModes: "Fire modes (0–4)", type: "Magazine type",
    normalTexturePath: "Main sprite", rackedTexturePath: "Racked sprite",
    nonEmptySpritePath: "Loaded magazine sprite", "item.png": "Item sprite"
};
const fields = byId("fields");
const canvas = byId("canvas");
const ctx = canvas.getContext("2d");
const imageCache = new Map();
const audioUrls = new Set();
let workspace, catalog = { entries: [], schema: editorSchema }, active, kind = "Guns", tab = tabs[0];
let timer, pending, loading = false, importing = 0, exporting = false;
let previewGeneration = 0, geometry, picking = false;

function el(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
}

function button(text, click) {
    const control = el("button", { type: "button", textContent: text });
    control.onclick = click;
    return control;
}

function option(value, text = value) {
    return new Option(text, value);
}

function status(message, error = false) {
    byId("status").textContent = message;
    byId("status").classList.toggle("error", error);
}

function saved(disk, imported = "Saved in memory · export ZIP to apply") {
    return workspace.onDisk ? disk : imported;
}

function renderList() {
    const term = byId("filter").value.toLowerCase();
    const entries = catalog.entries.filter(entry => entry.kind === kind &&
        (entry.id + " " + (entry.data?.fullName || "")).toLowerCase().includes(term));
    byId("items").replaceChildren(...entries.map(entry => {
        const control = button(entry.data?.fullName || entry.id, () => openItem(entry));
        control.className = "entry";
        control.setAttribute("aria-pressed", String(entry === active?.entry));
        control.append(el("small", { textContent: entry.id + (entry.error ? " / JSON error" : "") }));
        return control;
    }));
    byId("kinds").replaceChildren(...Object.entries(kinds).map(([value, title]) => {
        const control = button(title, () => { kind = value; renderList(); });
        control.setAttribute("aria-pressed", String(kind === value));
        return control;
    }));
    byId("create").disabled = !catalog.entries.some(entry => entry.kind === kind && entry.data);
}

async function flush(assetMove) {
    clearTimeout(timer);
    if (pending && !await pending) return false;
    if (!active?.dirty) return true;
    const target = active;
    const data = structuredClone(target.data);
    target.dirty = false;
    status("Saving…");
    pending = (async () => {
        try {
            const result = await workspace.saveItem(target.entry, { data, revision: target.revision, assetMove });
            target.revision = result.revision;
            target.entry.data = target.data;
            status(target.dirty ? "Unsaved changes…" : saved("Saved to disk"));
            renderList();
            return true;
        } catch (error) {
            target.dirty = true;
            status("Not saved: " + error.message, true);
            return false;
        } finally {
            pending = null;
        }
    })();
    return pending;
}

function changed() {
    active.dirty = true;
    clearTimeout(timer);
    status("Unsaved changes…");
    byId("title").textContent = active.data.fullName || active.entry.id;
    updatePreviewOptions();
    timer = setTimeout(flush, 250);
}

function setValue(key, value) {
    if (value === undefined) delete active.data[key];
    else active.data[key] = value;
    changed();
}

async function openItem(entry, discard = false, created) {
    if (loading || importing) return;
    loading = true;
    fields.inert = true;
    try {
        if (discard) {
            clearTimeout(timer);
            if (pending) await pending;
        } else if (!await flush()) return;
        const result = created || await workspace.readItem(entry);
        active = { entry, data: result.data, revision: result.revision };
        entry.data = result.data;
        delete entry.error;
        kind = entry.kind;
        picking = false;
        byId("variant").checked = false;
        byId("mag").replaceChildren();
        byId("title").textContent = active.data.fullName || entry.id;
        byId("path").textContent = entry.kind + "/" + entry.id;
        byId("reload").hidden = false;
        byId("duplicate").hidden = false;
        byId("delete-gun").hidden = entry.kind !== "Guns";
        renderList();
        renderFields();
        updatePreviewOptions();
        status(created ? saved("Created on disk") : saved("Loaded from disk", "Loaded from imported folder"));
    } catch (error) {
        status("Could not open " + entry.id + ": " + error.message, true);
    } finally {
        loading = false;
        fields.inert = false;
    }
}

function suggestions(key) {
    const values = new Set();
    for (const entry of catalog.entries) {
        const data = entry.data;
        if (key === "round") {
            if (entry.kind === "Rounds") values.add(entry.id);
            if (Array.isArray(data?.ammoTypes)) for (const ammo of data.ammoTypes)
                values.add(typeof ammo === "string" ? ammo : ammo?.round);
        } else if (Array.isArray(data?.[key])) {
            for (const value of data[key]) if (typeof value === "string") values.add(value);
        } else if (typeof data?.[key] === "string") values.add(data[key]);
    }
    return [...values].filter(Boolean).sort();
}

function textControl(value, commit, hints = [], immediate = false) {
    const input = el("input", { value: value ?? "" });
    const wrapper = el("div", { className: "control" });
    wrapper.append(input);
    if (hints.length) {
        const list = el("datalist", { id: "suggest-" + listId++ });
        list.append(...hints.map(hint => option(hint)));
        input.setAttribute("list", list.id);
        wrapper.append(list);
    }
    input[immediate ? "oninput" : "onchange"] = () => commit(input.value);
    return [wrapper, input];
}

function confirmAssetMove(old, name, canMove) {
    const dialog = byId("asset-rename");
    byId("asset-rename-path").textContent = "New path does not exist: " + old + " → " + name;
    byId("asset-rename-note").textContent = canMove
        ? "The file will be moved. Other references to the old path will not change."
        : "This file cannot be moved: it is shared, missing, or incompatible with the new path.";
    byId("asset-rename-move").disabled = !canMove;
    dialog.returnValue = "cancel";
    return new Promise(resolve => {
        dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
        dialog.showModal();
    });
}

function assetControl(value, commit, audio = false, icon = false) {
    const entry = active.entry;
    const control = el("div", { className: "control" });
    const row = el("div", { className: "asset" });
    const player = el("audio", { controls: true, preload: "none" });
    const thumb = el("span", { className: "thumb" });
    let generation = 0, audioUrl;
    const refreshAsset = async name => {
        const request = ++generation;
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
            audioUrls.delete(audioUrl);
            audioUrl = undefined;
        }
        player.hidden = true;
        player.removeAttribute("src");
        thumb.textContent = "—";
        thumb.title = name || "No sprite selected";
        if (!name) return;
        try {
            if (audio) {
                const asset = await workspace.findAsset(entry, name, true);
                if (!asset || request !== generation || !control.isConnected) return;
                audioUrl = URL.createObjectURL(asset.file);
                audioUrls.add(audioUrl);
                player.src = audioUrl;
                player.hidden = false;
            } else {
                const img = await image(entry, name);
                if (request !== generation || !control.isConnected) return;
                const thumbnail = el("canvas", { width: img.naturalWidth, height: img.naturalHeight, ariaHidden: "true" });
                thumbnail.getContext("2d").drawImage(img, 0, 0);
                thumb.replaceChildren(thumbnail);
            }
        } catch {
            if (!audio && request === generation) {
                thumb.textContent = "!";
                thumb.title = "PNG not found: " + name;
            }
        }
    };
    const input = el("input", { value: value || "", readOnly: icon, placeholder: audio ? "File name" : "Path without .png" });
    let savedName = value || "";
    const chooser = el("input", { type: "file", accept: audio ? audioExtensions : ".png", hidden: true });
    const browse = button("Import", () => chooser.click());
    const applyName = name => {
        savedName = input.value = name;
        commit(name || undefined);
        refreshAsset(name);
    };
    input.onchange = async () => {
        const name = (audio ? input.value.trim() : input.value.trim().replace(/\.png$/i, "")).replaceAll("\\", "/");
        const old = savedName;
        if (name === old) { input.value = old; return; }
        if (importing) { input.value = old; return; }
        if (!old || !name) { applyName(name); return; }
        importing++;
        input.readOnly = browse.disabled = true;
        const main = document.querySelector("main");
        try {
            const result = await workspace.assetStatus(entry, old, name, audio);
            if (!input.isConnected) return;
            const choice = result.exists ? "path" : await confirmAssetMove(old, name, result.canMove);
            if (choice === "path") applyName(name);
            else if (choice === "move") {
                main.inert = true;
                if (!await flush()) { input.value = old; return; }
                imageCache.clear();
                applyName(name);
                if (await flush({ old, name, audio })) {
                    imageCache.clear();
                    refreshAsset(name);
                    drawPreview();
                } else {
                    const error = byId("status").textContent;
                    imageCache.clear();
                    applyName(old);
                    clearTimeout(timer);
                    active.dirty = false;
                    status(error, true);
                }
            } else input.value = old;
        } catch (error) {
            input.value = old;
            status("Could not check path: " + error.message, true);
        } finally {
            main.inert = false;
            input.readOnly = icon;
            browse.disabled = false;
            importing--;
        }
    };
    chooser.onchange = async () => {
        const file = chooser.files[0];
        if (!file || entry !== active?.entry) return;
        importing++;
        browse.disabled = true;
        try {
            const result = await workspace.importAsset(entry, file, audio, icon);
            imageCache.clear();
            applyName(result.name);
            if (icon) status(saved("Sprite saved to disk"));
        } catch (error) {
            status("Import: " + error.message, true);
        } finally {
            importing--;
            browse.disabled = false;
            chooser.value = "";
        }
    };
    if (!audio) row.append(thumb);
    row.append(input, browse, chooser);
    control.append(row);
    if (audio) control.append(player);
    refreshAsset(value);
    return [control, input];
}

function jsonControl(value, commit, accepts) {
    const input = el("textarea", { value: value === undefined ? "" : JSON.stringify(value, null, 2), spellcheck: false });
    input.onchange = () => {
        try {
            const parsed = input.value.trim() ? JSON.parse(input.value) : undefined;
            if (parsed !== undefined && !accepts(parsed)) throw new Error("Invalid field type.");
            input.setCustomValidity("");
            commit(parsed);
        } catch (error) {
            input.setCustomValidity(error.message);
            input.reportValidity();
        }
    };
    return [input, input];
}

function listControl(key, value, commit) {
    if (value !== undefined && !Array.isArray(value)) return jsonControl(value, commit, Array.isArray);
    const wrapper = el("div", { className: "control" });
    const list = [...(value || [])];
    const sprites = spriteLists.has(key);
    const hints = suggestions(key === "ammoTypes" ? "round" : key);
    function draw() {
        wrapper.replaceChildren();
        list.forEach((value, index) => {
            const row = el("div", { className: "map-row" });
            if (sprites) {
                const [sprite, input] = assetControl(value, name => {
                    list[index] = name ?? null;
                    commit([...list]);
                });
                input.setAttribute("aria-label", key + " " + (index + 1));
                row.append(el("small", { textContent: "#" + index }), sprite);
            } else {
                const [control, input] = textControl(value, next => {
                    if (key === "fireModes" && !/^[0-4]$/.test(next)) {
                        input.value = list[index];
                        return;
                    }
                    list[index] = key === "fireModes" ? Number(next) : next;
                    commit([...list]);
                }, key === "fireModes" ? ["0", "1", "2", "3", "4"] : hints);
                input.setAttribute("aria-label", key);
                if (key === "fireModes") Object.assign(input, { type: "number", min: 0, max: 4, step: 1 });
                row.append(control);
            }
            row.append(button(sprites ? "Clear sprite" : "− Delete", () => {
                if (sprites) list[index] = null;
                else list.splice(index, 1);
                commit([...list]);
                draw();
            }));
            wrapper.append(row);
        });
        wrapper.append(button(sprites ? "+ Sprite slot" : "+ Add", () => {
            if (sprites && !list.length) {
                const count = key === "bulletsSpritesPath"
                    ? (active.data.ammoTypes?.length || 0) + 2
                    : Math.max(0, ...(active.data.fireModes || [])) + 1;
                list.push(...Array(count).fill(null));
            } else list.push(key === "fireModes" ? 2 : sprites ? null : hints[0] || "");
            commit([...list]);
            draw();
        }));
        if (sprites && list.length) wrapper.append(button("Restore default sprites", () => {
            list.length = 0;
            commit(undefined);
            draw();
        }));
    }
    draw();
    return [wrapper, wrapper.querySelector("input, button")];
}

function fieldRow(key, control, input, title = labels[key] || key) {
    if (!input.id) input.id = "field-" + listId++;
    const row = el("div", { className: "field" });
    row.append(el("label", { htmlFor: input.id, textContent: title, title: key }), control);
    return row;
}

function scalar(key, spec, value, commit) {
    const boolean = spec.type === "bool";
    const input = boolean
        ? el("input", { type: "checkbox", checked: value ?? (spec.default === "true") })
        : el("input", { type: "number", step: spec.type === "int" ? "1" : "any",
            value: value ?? "", placeholder: spec.default || "0" });
    input[boolean ? "onchange" : "oninput"] = () => {
        if (input.validity.valid)
            commit(boolean ? input.checked : input.value === "" ? undefined : input.valueAsNumber);
    };
    return fieldRow(key, input, input);
}

function ammoEditor() {
    const gun = active.entry.kind === "Guns";
    const data = active.data;
    const feedIsBattery = gun && (String(data.feedType).toLowerCase() === "battery" || data.feedType === 5);
    const isMagazineFed = gun && (String(data.feedType).toLowerCase() === "magazine" || data.feedType === 1);
    const hints = suggestions("round");
    const wrapper = el("div", { className: "control" });
    const source = Array.isArray(data.ammoTypes) ? data.ammoTypes : [];
    const list = [...source];
    const ids = () => new Set(list.map(ammo => gun ? ammo?.round : ammo));
    const limit = feedIsBattery ? 1 : 127;
    const minimum = 1;
    const publish = () => setValue("ammoTypes", [...list]);
    const magazineRounds = new Map();
    const panel = el("section", { className: "ammo-suggestions" });
    const types = Array.isArray(data.magazineType) ? data.magazineType : [];
    if (isMagazineFed) {
        for (const entry of catalog.entries) {
            const mag = entry.data;
            if (entry.kind !== "Mags" || !Array.isArray(mag?.ammoTypes) || !Array.isArray(mag.magazineType) ||
                String(mag.type).toLowerCase() === "battery" || mag.type === 2 ||
                !mag.magazineType.some(type => types.includes(type))) continue;
            for (const round of mag.ammoTypes) {
                if (typeof round !== "string" || !round.trim()) continue;
                if (!magazineRounds.has(round)) magazineRounds.set(round, []);
                magazineRounds.get(round).push(mag.fullName || entry.id);
            }
        }
    }

    function add(idsToAdd) {
        for (const round of idsToAdd.slice(0, limit - list.length)) {
            if (!gun) { list.push(round); continue; }
            const profile = catalog.entries
                .filter(entry => entry.kind === "Guns" && Array.isArray(entry.data?.ammoTypes))
                .flatMap(entry => entry.data.ammoTypes)
                .find(ammo => ammo?.round === round);
            const copied = structuredClone(profile || { round, pellets: 1 });
            delete copied.casingSprite;
            delete copied.minigameCasingSprite;
            list.push(copied);
        }
        if (gun && Array.isArray(data.bulletsSpritesPath) && data.bulletsSpritesPath.length) {
            const paths = [...data.bulletsSpritesPath];
            while (paths.length < list.length + 2) paths.push("COPY__Resources/bulletRound");
            data.bulletsSpritesPath = paths;
        }
        publish();
        draw();
    }

    function drawSuggestions(chosen) {
        panel.replaceChildren();
        const missing = [...magazineRounds].filter(([round]) => !chosen.has(round));
        panel.append(el("strong", { textContent: "From compatible magazines" }));
        if (!missing.length) panel.append(el("small", { textContent: "All suggested rounds are already included." }));
        if (missing.length > 1) {
            const addAll = button("+ Add all", () => add(missing.map(([round]) => round)));
            addAll.disabled = list.length >= limit;
            panel.append(addAll);
        }
        for (const [round, magazines] of missing) {
            const control = button("+ " + round, () => add([round]));
            control.disabled = list.length >= limit;
            panel.append(control, el("small", { textContent: magazines.join(", ") }));
        }
    }

    function draw() {
        wrapper.replaceChildren();
        const chosen = ids();
        if (magazineRounds.size) {
            drawSuggestions(chosen);
            wrapper.append(panel);
        }

        list.forEach((ammo, index) => {
            const round = gun ? ammo?.round : ammo;
            const row = el("div", { className: "map-row" });
            const [control, input] = textControl(round, value => {
                const next = value.trim();
                const previous = gun ? list[index]?.round : list[index];
                if (!next || (next !== previous && ids().has(next))) {
                    input.value = previous ?? "";
                    return;
                }
                list[index] = gun ? { ...list[index], round: next } : next;
                if (gun) row.querySelector("summary").textContent = "Profile: " + next;
                publish();
                if (magazineRounds.size) drawSuggestions(ids());
                check();
            }, hints);
            row.append(fieldRow("round", control, input, "Round ID"));
            if (gun) {
                const profile = el("details", { className: "ammo-profile" });
                profile.append(el("summary", { textContent: "Profile: " + (round || "—") }));
                const update = (key, value) => {
                    const next = { ...list[index] };
                    if (value === undefined) delete next[key];
                    else next[key] = value;
                    list[index] = next;
                    publish();
                };
                const [sprite, spriteInput] = assetControl(ammo?.casingSprite, value => update("casingSprite", value));
                profile.append(fieldRow("casingSprite", sprite, spriteInput, "Casing sprite"));
                for (const [key, spec] of Object.entries(catalog.schema.AmmoInfo)) {
                    if (["round", "casingSprite", "minigameCasingSprite"].includes(key) ||
                        !["bool", "float", "int"].includes(spec.type)) continue;
                    profile.append(scalar(key, spec, ammo?.[key], value => update(key, value)));
                }
                const damage = el("details", { className: "ammo-profile" });
                damage.append(el("summary", { textContent: "Character damage" }));
                for (const [key, spec] of Object.entries(catalog.schema.PlayerDamage)) {
                    damage.append(scalar(key, spec, ammo?.playerDamage?.[key], value => {
                        const next = { ...list[index]?.playerDamage };
                        if (value === undefined) delete next[key];
                        else next[key] = value;
                        update("playerDamage", Object.keys(next).length ? next : undefined);
                    }));
                }
                const [explosion, explosionInput] = jsonControl(ammo?.explosionParams, value => update("explosionParams", value),
                    value => value && typeof value === "object" && !Array.isArray(value));
                profile.append(damage, fieldRow("explosionParams", explosion, explosionInput, "Explosion settings (JSON)"));
                row.append(profile);
            }
            const remove = button("− Delete", () => {
                list.splice(index, 1);
                if (gun && Array.isArray(data.bulletsSpritesPath) && data.bulletsSpritesPath.length) {
                    data.bulletsSpritesPath = data.bulletsSpritesPath.filter((_, slot) => slot !== index + 2);
                }
                publish();
                draw();
            });
            remove.disabled = list.length <= minimum;
            row.append(remove);
            wrapper.append(row);
        });

        const [picker, input] = textControl("", () => {}, hints.filter(round => !chosen.has(round)));
        input.placeholder = "Choose or enter a round ID";
        input.setAttribute("aria-label", "New round ID");
        const addManual = button("+ Add round", () => {
            const round = input.value.trim();
            if (round && !ids().has(round)) add([round]);
        });
        const check = () => {
            addManual.disabled = !input.value.trim() || ids().has(input.value.trim()) || list.length >= limit;
        };
        input.oninput = check;
        input.onkeydown = event => { if (event.key === "Enter" && !addManual.disabled) addManual.click(); };
        check();
        const controls = el("div", { className: "ammo-actions" });
        controls.append(picker, addManual);
        wrapper.append(controls);
    }
    draw();
    return wrapper;
}

function textureMap(value, commit) {
    const wrapper = el("div", { className: "control" });
    const map = new Map(Object.entries(value || {}));
    const publish = () => commit(Object.fromEntries(map));
    function draw() {
        wrapper.replaceChildren();
        for (const [id, path] of map) {
            const row = el("div", { className: "map-row" });
            const [asset] = assetControl(path, name => { map.set(id, name || ""); publish(); });
            row.append(el("small", { textContent: id }), asset, button("− Delete", () => { map.delete(id); publish(); draw(); }));
            wrapper.append(row);
        }
        const select = el("select", { ariaLabel: "Magazine for new layer" });
        const gunTypes = Array.isArray(active.data.magazineType) ? active.data.magazineType : [];
        const compatible = entry => Array.isArray(entry.data?.magazineType) &&
            entry.data.magazineType.some(type => gunTypes.includes(type));
        const available = catalog.entries.filter(entry => entry.kind === "Mags" && !map.has(entry.id));
        available.sort((left, right) => Number(compatible(right)) - Number(compatible(left)));
        select.append(...available.map(entry => option(entry.id, entry.id)));
        const add = button("+ Magazine layer", () => {
            if (!select.value) return;
            map.set(select.value, "");
            publish();
            draw();
        });
        add.disabled = !available.length;
        wrapper.append(select, add);
    }
    draw();
    return [wrapper, wrapper.querySelector("select")];
}

let listId = 0;
function renderFields() {
    for (const url of audioUrls) URL.revokeObjectURL(url);
    audioUrls.clear();
    const visibleTabs = active && active.entry.kind !== "Rounds" ? [tabs[0], tabs[1], ammoTab, tabs[2]] : tabs;
    if (!visibleTabs.includes(tab)) tab = tabs[0];
    byId("tabs").replaceChildren(...visibleTabs.map(title => {
        const control = button(title, () => { tab = title; renderFields(); });
        control.setAttribute("aria-pressed", String(tab === title));
        return control;
    }));
    fields.replaceChildren();
    if (!active) return;
    if (tab === ammoTab) {
        fields.append(ammoEditor());
        return;
    }
    const { entry, data } = active;
    const schema = catalog.schema[entry.kind];
    const names = Object.keys(schema).filter(key => key !== "ammoTypes");
    if (entry.kind !== "Guns") names.push("item.png");
    for (const key of names) {
        const resource = key.endsWith("Path") || key === "item.png";
        if (tab !== (resource ? tabs[2] : basic.has(key) ? tabs[0] : tabs[1])) continue;
        const value = data[key];
        const commit = next => setValue(key, next);
        const spec = schema[key];
        let control, input;
        if (key === "item.png") {
            [control, input] = assetControl("item", () => drawPreview(), false, true);
        } else if (key === "magazineTexturesPath") {
            [control, input] = textureMap(value, commit);
        } else if (spriteLists.has(key)) {
            [control, input] = listControl(key, value, commit);
        } else if (resource) {
            [control, input] = assetControl(value, commit, key.endsWith("AudioPath"));
        } else if (spec.type.startsWith("List")) {
            [control, input] = listControl(key, value, commit);
        } else if (key === "description") {
            control = input = el("textarea", { value: value || "" });
            input.oninput = () => commit(input.value);
        } else if (spec.type === "FeedKind" || spec.type === "MagazineKind") {
            const isFeed = spec.type === "FeedKind";
            const options = isFeed ? feed : magKinds;
            const display = typeof value === "number" ? options[value - (isFeed ? 1 : 0)] : options.find(name => name.toLowerCase() === String(value).toLowerCase());
            control = input = el("select");
            input.append(option("", isFeed ? "Not set" : "Regular (default)"), ...options.map(name => option(name)));
            if (value != null && !display) input.append(option(String(value), String(value) + " (from file)"));
            input.value = display ?? value ?? "";
            input.onchange = () => commit(input.value || undefined);
        } else if (spec.type === "bool") {
            control = input = el("input", { type: "checkbox", checked: value ?? (spec.default === "true") });
            input.onchange = () => commit(input.checked);
        } else if (spec.type === "int" || spec.type === "float") {
            control = input = el("input", { type: "number", step: spec.type === "int" ? "1" : "any",
                value: value ?? "", placeholder: spec.default || "0" });
            input.oninput = () => {
                if (input.validity.valid) commit(input.value === "" ? undefined : input.valueAsNumber);
            };
        } else {
            [control, input] = textControl(value, commit, suggestions(key), true);
        }
        input.id = "field-" + key;
        fields.append(fieldRow(key, control, input));
    }
    if (!fields.childElementCount) fields.append(el("small", { textContent: "No settings in this tab." }));
}

function updatePreviewOptions() {
    const gun = active.entry.kind === "Guns";
    const magazine = active.entry.kind === "Mags";
    const mag = byId("mag");
    const previous = mag.value;
    byId("variant-text").textContent = gun ? "Action racked" : "Magazine loaded";
    mag.replaceChildren(option("", "No magazine"), ...Object.keys(active.data.magazineTexturesPath || {}).map(id => option(id)));
    mag.value = [...mag.options].some(item => item.value === previous) ? previous : "";
    byId("variant-label").hidden = !gun && !magazine;
    byId("mag-label").hidden = !gun;
    byId("grab").hidden = !gun;
    drawPreview();
}

function image(entry, name, optional = false) {
    if (!name) return Promise.resolve(null);
    const key = JSON.stringify([entry.kind, entry.id, name]);
    if (!imageCache.has(key)) {
        if (imageCache.size >= 64) imageCache.delete(imageCache.keys().next().value);
        imageCache.set(key, (async () => {
            const asset = await workspace.findAsset(entry, name);
            if (!asset) return null;
            const url = URL.createObjectURL(asset.file);
            const img = new Image();
            img.src = url;
            try { await img.decode(); return img; }
            catch { return null; }
            finally { URL.revokeObjectURL(url); }
        })());
    }
    return imageCache.get(key).then(img => {
        if (!img && !optional) throw new Error("PNG not found: " + name);
        return img;
    });
}

function combine(base, overlay) {
    const surface = el("canvas", { width: base.width, height: base.height });
    const context = surface.getContext("2d");
    context.drawImage(base, 0, 0);
    const pixels = context.getImageData(0, 0, base.width, base.height);
    const keyed = (data, offset) => data[offset] === 255 && data[offset + 1] === 0 &&
        data[offset + 2] === 255 && data[offset + 3] === 255;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
        if (keyed(pixels.data, offset)) pixels.data[offset + 3] = 0;
    }
    if (overlay) {
        context.clearRect(0, 0, base.width, base.height);
        context.drawImage(overlay, 0, 0);
        const layer = context.getImageData(0, 0, base.width, base.height);
        for (let offset = 0; offset < layer.data.length; offset += 4) {
            if (!keyed(layer.data, offset)) pixels.data.set(layer.data.subarray(offset, offset + 4), offset);
        }
    }
    context.putImageData(pixels, 0, 0);
    return surface;
}

function convertGripAxes(x, y, { cos, sin }) {
    return { x: -cos * x - sin * y, y: -sin * x + cos * y };
}

async function drawPreview() {
    const generation = ++previewGeneration;
    geometry = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    byId("grip").textContent = "";
    canvas.classList.toggle("picking", picking);
    byId("grab").setAttribute("aria-pressed", String(picking));
    if (!active) return;
    const { data, entry } = active;
    const gun = entry.kind === "Guns";
    const variant = byId("variant").checked;
    const name = gun ? (variant ? data.rackedTexturePath : data.normalTexturePath) :
        (variant ? data.nonEmptySpritePath || "item" : "item");
    const layerName = gun && data.magazineTexturesPath?.[byId("mag").value];
    const note = byId("preview-note");
    note.textContent = "";
    try {
        const [base, overlay] = await Promise.all([image(entry, name), image(entry, layerName, true)]);
        if (generation !== previewGeneration) return;
        if (!base) { note.textContent = "Choose a sprite in the Assets tab."; return; }
        const mismatch = overlay && (overlay.width !== base.width || overlay.height !== base.height);
        if (mismatch) note.textContent = "Layer skipped: its dimensions differ from the base sprite.";
        else if (layerName && !overlay) note.textContent = "Magazine layer not found: " + layerName;
        else note.textContent = base.width + " × " + base.height + " px";
        const zoom = Math.min(14, 440 / base.width, 290 / base.height);
        const centerX = canvas.width / 2, centerY = canvas.height / 2;
        ctx.imageSmoothingEnabled = false;
        for (let x = 0; x < canvas.width; x += 20) for (let y = 0; y < canvas.height; y += 20) {
            ctx.fillStyle = (x / 20 + y / 20) % 2 ? "#181818" : "#202020";
            ctx.fillRect(x, y, 20, 20);
        }
        ctx.drawImage(gun ? combine(base, mismatch ? null : overlay) : base,
            centerX - base.width * zoom / 2, centerY - base.height * zoom / 2, base.width * zoom, base.height * zoom);
        if (!gun) return;
        const ppu = Number(data.ppu) > 0 ? Number(data.ppu) : 8;
        const offsetX = Number(data.itemSpriteXOffset) || 0, offsetY = Number(data.itemSpriteYOffset) || 0;
        const configuredAngle = Number(data.slotRotation ?? catalog.schema.Guns.slotRotation.default);
        const angle = (Number.isFinite(configuredAngle) ? configuredAngle : -90) * Math.PI / 180;
        geometry = { centerX, centerY, factor: ppu * zoom, cos: Math.cos(angle), sin: Math.sin(angle) };
        const hand = convertGripAxes(offsetX, offsetY, geometry);
        const handX = centerX + hand.x * geometry.factor, handY = centerY + hand.y * geometry.factor;
        ctx.strokeStyle = "#e0ded5";
        ctx.strokeRect(centerX - 4, centerY - 4, 8, 8);
        ctx.strokeStyle = "#ffab62";
        ctx.lineWidth = 2;
        const markerX = Math.min(canvas.width - 14, Math.max(14, handX));
        const markerY = Math.min(canvas.height - 14, Math.max(14, handY));
        ctx.beginPath();
        ctx.moveTo(markerX - 11, markerY); ctx.lineTo(markerX + 11, markerY);
        ctx.moveTo(markerX, markerY - 11); ctx.lineTo(markerX, markerY + 11);
        ctx.stroke();
        ctx.lineWidth = 1;
        byId("grip").textContent = "□ sprite center · + grip · X " + offsetX + " / Y " + offsetY +
            (markerX !== handX || markerY !== handY ? " · grip outside frame" : "");
    } catch (error) {
        if (generation === previewGeneration) note.textContent = error.message;
    }
}

byId("grab").onclick = () => { picking = !picking; drawPreview(); };
canvas.onclick = event => {
    if (!picking || !geometry) return;
    const bounds = canvas.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * canvas.width / bounds.width;
    const y = (event.clientY - bounds.top) * canvas.height / bounds.height;
    const { centerX, centerY, factor } = geometry;
    const offset = convertGripAxes((x - centerX) / factor, (y - centerY) / factor, geometry);
    active.data.itemSpriteXOffset = Number(offset.x.toFixed(4));
    active.data.itemSpriteYOffset = Number(offset.y.toFixed(4));
    picking = false;
    changed();
    renderFields();
};
byId("mag").onchange = byId("variant").onchange = drawPreview;
byId("filter").oninput = () => renderList();
byId("reload").onclick = () => {
    if (active && (!active.dirty || confirm("Discard unsaved changes?"))) {
        imageCache.clear();
        openItem(active.entry, true);
    }
};

const dialog = byId("new-item");
let createKind;
function openCreate(duplicate) {
    if (importing || loading) return;
    createKind = duplicate ? active.entry.kind : kind;
    byId("new-form").reset();
    byId("dialog-title").textContent = duplicate ? "Duplicate item" : "New item";
    byId("submit-item").textContent = duplicate ? "Duplicate" : "Create";
    byId("create-error").textContent = "";
    const template = byId("template");
    template.disabled = duplicate;
    const sources = duplicate ? [active.entry] : catalog.entries.filter(entry => entry.kind === createKind && entry.data);
    template.replaceChildren(...sources.map(entry => option(entry.id, (entry.data.fullName || entry.id) + " · " + entry.id)));
    if (active?.entry.kind === createKind) template.value = active.entry.id;
    if (duplicate) {
        const existing = new Set(catalog.entries.filter(entry => entry.kind === createKind).map(entry => entry.id));
        const base = active.entry.id + ".copy";
        let identifier = base;
        for (let number = 2; existing.has(identifier); number++) identifier = base + number;
        byId("new-id").value = identifier;
        byId("new-name").value = (active.data.fullName || active.entry.id) + " (copy)";
    }
    dialog.showModal();
}
byId("create").onclick = () => openCreate(false);
byId("duplicate").onclick = () => openCreate(true);
byId("cancel").onclick = () => dialog.close();
byId("new-form").onsubmit = async event => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
        if (!await flush()) throw new Error("Save or reload the open config first.");
        const request = { kind: createKind, id: byId("new-id").value.trim(), name: byId("new-name").value.trim(),
            template: byId("template").value };
        if (!request.name) throw new Error("Enter a name.");
        const result = await workspace.create(request);
        const entry = { kind: request.kind, id: request.id, data: result.data };
        catalog.entries.push(entry);
        dialog.close();
        byId("filter").value = "";
        tab = tabs[0];
        await openItem(entry, false, result);
    } catch (error) {
        byId("create-error").textContent = error.message;
    } finally {
        submit.disabled = false;
    }
};

const deleteDialog = byId("delete-dialog");
const confirmDelete = byId("confirm-delete");
const cancelDelete = byId("cancel-delete");
byId("delete-gun").onclick = () => {
    if (loading || importing || active?.entry.kind !== "Guns") return;
    byId("delete-name").textContent = (active.data.fullName || active.entry.id) + " · " + active.entry.id;
    byId("delete-error").textContent = "";
    deleteDialog.showModal();
};
cancelDelete.onclick = () => deleteDialog.close();
deleteDialog.oncancel = event => { if (confirmDelete.disabled) event.preventDefault(); };
confirmDelete.onclick = async () => {
    const target = active;
    let result;
    confirmDelete.disabled = cancelDelete.disabled = loading = true;
    try {
        if (!await flush()) throw new Error("Save or reload the open config first.");
        result = await workspace.deleteGun(target.entry, target.revision);
    } catch (error) {
        byId("delete-error").textContent = error.message;
        return;
    } finally {
        confirmDelete.disabled = cancelDelete.disabled = loading = false;
    }
    deleteDialog.close();
    catalog.entries = catalog.entries.filter(entry => entry !== target.entry);
    for (const updated of result.updated) {
        const entry = catalog.entries.find(entry => entry.id === updated.id && entry.kind === updated.kind);
        if (entry) { entry.data = updated.data; delete entry.error; }
        else catalog.entries.push(updated);
    }
    resetSelection();
    const next = catalog.entries.find(entry => entry.kind === "Guns" && entry.data);
    if (next) await openItem(next);
    status("Weapon deleted · configs updated: " + result.updated.length + (workspace.onDisk ? "" : " · export ZIP to apply"));
};

function resetSelection() {
    active = null;
    imageCache.clear();
    byId("title").textContent = "Select an item";
    byId("path").textContent = "";
    for (const id of ["reload", "duplicate", "delete-gun", "variant-label", "mag-label", "grab"])
        byId(id).hidden = true;
    byId("preview-note").textContent = "";
    picking = false;
    drawPreview();
    renderFields();
    renderList();
}

window.addEventListener("beforeunload", event => {
    if (active?.dirty || pending || importing || exporting || confirmDelete.disabled || (workspace && !workspace.onDisk && workspace.modified)) {
        event.preventDefault();
        event.returnValue = "";
    }
});

async function openWorkspace(folder) {
    if (loading || importing || exporting) return;
    if (workspace && !workspace.onDisk && (workspace.modified || pending || active?.dirty) &&
        !confirm("Discard the unexported edits to this folder?")) return;
    const next = new Workspace(folder);
    const main = document.querySelector("main");
    loading = main.inert = true;
    let first;
    try {
        if (!await flush()) return;
        status("Reading folder…");
        const entries = await next.catalog();
        workspace = next;
        catalog = entries;
        byId("root").textContent = folder.name + (folder.onDisk ? " · direct access" : " · imported copy");
        byId("filter").value = "";
        byId("export-folder").hidden = folder.onDisk;
        resetSelection();
        first = catalog.entries.find(entry => entry.kind === kind && entry.id === "pistol" && entry.data) ||
            catalog.entries.find(entry => entry.data);
        if (!first) status("There are no usable templates in this folder.");
    } catch (error) {
        status(error.message, true);
    } finally {
        loading = main.inert = false;
    }
    if (first) await openItem(first);
}

byId("open-folder").hidden = typeof window.showDirectoryPicker !== "function";
byId("open-folder").onclick = async () => {
    try {
        const handle = await window.showDirectoryPicker({ mode: "readwrite" });
        await openWorkspace(new DiskFolder(handle));
    } catch (error) {
        if (error.name !== "AbortError") status(error.message, true);
    }
};
byId("import-folder").onclick = () => byId("folder-input").click();
byId("folder-input").onchange = async event => {
    try {
        if (event.target.files.length) await openWorkspace(new ImportedFolder(Array.from(event.target.files)));
    } catch (error) {
        status(error.message, true);
    } finally {
        event.target.value = "";
    }
};
byId("export-folder").onclick = async () => {
    if (!workspace || loading || importing || exporting) return;
    const main = document.querySelector("main");
    exporting = main.inert = true;
    try {
        if (!await flush()) return;
        status("Preparing ZIP…");
        const zip = await exportZip(workspace);
        const url = URL.createObjectURL(zip);
        const link = el("a", { href: url, download: workspace.name + "-edited.zip" });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        workspace.modified = false;
        status("ZIP exported");
    } catch (error) {
        status("Export failed: " + error.message, true);
    } finally {
        exporting = main.inert = false;
    }
};
renderList();
