import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@latest/+esm";

// ===== State =====
const state = {
  db: null,
  conn: null,
  fileName: null,
  tableQuery: null,
  columns: [],
};

// ===== DOM =====
const els = {
  fileInput:         document.getElementById("fileInput"),
  fileDropZone:      document.getElementById("fileDropZone"),
  fileStatus:        document.getElementById("fileStatus"),
  runBtn:            document.getElementById("runQuery"),
  exportExcelBtn:    document.getElementById("exportExcel"),
  resetQueryBtn:     document.getElementById("resetQueryBtn"),
  resultActions:     document.getElementById("resultActions"),
  resultCount:       document.getElementById("resultCount"),
  resultPlaceholder: document.getElementById("resultPlaceholder"),
  builderBody:       document.getElementById("builderBody"),
  dbStatus:          document.getElementById("dbStatus"),
  appMain:           document.getElementById("appMain"),
  colRight:          document.querySelector(".col-right"),
};

const sqlPreview = document.getElementById("sqlPreview");
let isQueryEdited = false;

// ===== Status helpers =====
function setDbStatus(text, type = "") {
  els.dbStatus.textContent = text;
  els.dbStatus.className = "db-status" + (type ? " " + type : "");
}

function setFileStatus(message, type = "") {
  els.fileStatus.textContent = message;
  els.fileStatus.className = "file-status" + (type ? " " + type : "");
}

function isNumericType(typeStr) {
  return ["INTEGER","DOUBLE","FLOAT","BIGINT","SMALLINT","TINYINT","DECIMAL","HUGEINT","UINTEGER","UBIGINT","INT"]
    .some(t => typeStr.includes(t));
}

function logMemory() {
  if (performance?.memory) {
    console.log(`Mémoire: ${(performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB`);
  }
}

function activateSplitLayout() {
  if (els.appMain.classList.contains("layout-split")) return;
  // Synchronise la variable CSS avec la vraie hauteur du header
  const headerH = document.querySelector(".app-header").offsetHeight;
  document.documentElement.style.setProperty("--header-h", headerH + "px");
  els.appMain.classList.add("layout-split");
}

// Sur mobile, fait défiler vers les résultats après exécution
function scrollToResultsOnMobile() {
  if (window.innerWidth <= 900) {
    els.colRight.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ===== DuckDB =====
async function initDuckDB() {
  try {
    setDbStatus("⏳ Initialisation…");
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    state.db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await state.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    state.conn = await state.db.connect();
    URL.revokeObjectURL(workerUrl);
    setDbStatus("✅ Prêt", "ready");
  } catch (err) {
    console.error(err);
    setDbStatus("❌ Erreur DuckDB", "error");
  }
}

async function resetDuckDB() {
  if (state.conn) { await state.conn.close(); state.conn = null; }
  if (state.db)   { await state.db.terminate(); state.db = null; }
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  state.db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await state.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  state.conn = await state.db.connect();
  URL.revokeObjectURL(workerUrl);
}

// ===== File Loading =====
els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadFile(file);
});

els.fileDropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.fileDropZone.classList.add("drag-over");
});
els.fileDropZone.addEventListener("dragleave", () => {
  els.fileDropZone.classList.remove("drag-over");
});
els.fileDropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.fileDropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  const name = file.name.toLowerCase();
  const isParquet = name.endsWith(".parquet");
  const isCsv = name.endsWith(".csv");

  if (!isParquet && !isCsv) {
    setFileStatus("❌ Format non supporté — utilisez .parquet ou .csv", "error");
    return;
  }

  els.runBtn.disabled = true;

  try {
    setFileStatus("⏳ Réinitialisation de DuckDB…", "loading");
    await resetDuckDB();
    logMemory();

    setFileStatus(`⏳ Chargement de ${file.name}…`, "loading");
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) throw new Error("Le fichier est vide.");

    if (isParquet) {
      await state.db.registerFileBuffer("data.parquet", new Uint8Array(buffer));
      state.tableQuery = "parquet_scan('data.parquet')";
    } else {
      await state.db.registerFileBuffer("data.csv", new Uint8Array(buffer));
      state.tableQuery = "read_csv_auto('data.csv')";
    }

    state.fileName = file.name;

    // Réinitialiser l'état SQL editor
    isQueryEdited = false;
    sqlPreview.classList.remove("edited");
    sqlPreview.textContent = "SELECT …";

    await loadColumns();

    activateSplitLayout();
    els.runBtn.disabled = false;
    setFileStatus(`✅ ${file.name} — ${state.columns.length} colonne${state.columns.length > 1 ? "s" : ""} détectée${state.columns.length > 1 ? "s" : ""}`, "success");
  } catch (err) {
    console.error(err);
    setFileStatus(`❌ ${err.message}`, "error");
  }
}

// ===== Schema & Preview =====
async function loadColumns() {
  const result = await state.conn.query(`SELECT * FROM ${state.tableQuery} LIMIT 0`);
  if (!result.schema?.fields) throw new Error("Schéma introuvable dans le fichier.");
  state.columns = result.schema.fields;
  renderQueryBuilder();
  await loadInitialRows();
}

async function loadInitialRows() {
  try {
    const result = await state.conn.query(`SELECT * FROM ${state.tableQuery} LIMIT 100`);
    const rows = result.toArray();
    if (rows.length > 0) displayResults(rows, true);
  } catch (err) {
    console.error("Erreur aperçu:", err);
  }
}

// ===== Query Builder =====
function renderQueryBuilder() {
  // Masquer le placeholder
  const placeholder = document.getElementById("builderPlaceholder");
  if (placeholder) placeholder.style.display = "none";

  let container = document.getElementById("queryBuilderContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "queryBuilderContainer";
    els.builderBody.appendChild(container);
  }

  container.innerHTML = `
    <div class="qb-section">
      <div class="qb-section-header">
        <span class="qb-section-title">Colonnes &amp; agrégations</span>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;cursor:pointer;color:var(--text-muted);">
          <input type="checkbox" id="qbSelectAll" checked> Tout sélectionner
        </label>
      </div>
      <div class="qb-columns-grid" id="qbColumnsList"></div>
    </div>

    <div class="qb-section">
      <div class="qb-section-header">
        <span class="qb-section-title">Filtres</span>
        <button class="btn btn-sm" id="qbAddFilterBtn" style="background:var(--success);color:white;">+ Ajouter un filtre</button>
      </div>
      <div id="qbFiltersList"></div>
    </div>

    <div class="qb-section">
      <div class="qb-section-header">
        <span class="qb-section-title">Options</span>
      </div>
      <div class="options-row">
        <div class="options-group">
          <label>Trier par</label>
          <select id="qbSortCol"><option value="">— Aucun —</option></select>
          <select id="qbSortDir">
            <option value="ASC">Croissant</option>
            <option value="DESC">Décroissant</option>
          </select>
        </div>
        <div class="options-group">
          <label>Limite</label>
          <input type="number" id="qbLimit" value="1000" min="1" style="width:90px;">
        </div>
      </div>
    </div>
  `;

  const colList = document.getElementById("qbColumnsList");
  const sortSelect = document.getElementById("qbSortCol");

  document.getElementById("qbSelectAll").addEventListener("change", (e) => {
    colList.querySelectorAll(".qb-col-check").forEach(cb => (cb.checked = e.target.checked));
    updateSQLPreview();
  });

  state.columns.forEach((col, idx) => {
    const name = col.name;
    const type = col.type.toString().toUpperCase();
    const isNum = isNumericType(type);
    const id = `col_${idx}`;

    const div = document.createElement("div");
    div.className = "qb-col-item";
    div.innerHTML = `
      <input type="checkbox" class="qb-col-check" value="${name}" id="${id}" checked>
      <label for="${id}" class="qb-col-label" title="${name}">${name}</label>
      <span class="type-badge">${type}</span>
      <select class="qb-col-agg" data-col="${name}">
        <option value="">(valeur)</option>
        ${isNum ? `
          <option value="SUM">Somme</option>
          <option value="AVG">Moyenne</option>
          <option value="MIN">Min</option>
          <option value="MAX">Max</option>
        ` : ""}
        <option value="COUNT">Compte</option>
      </select>
    `;
    colList.appendChild(div);

    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sortSelect.appendChild(opt);
  });

  document.getElementById("qbAddFilterBtn").addEventListener("click", addFilterRow);
  container.addEventListener("change", updateSQLPreview);
  container.addEventListener("input", updateSQLPreview);

  addFilterRow();
  updateSQLPreview();
}

function addFilterRow() {
  const list = document.getElementById("qbFiltersList");
  const div = document.createElement("div");
  div.className = "qb-filter-row";

  const colOptions = [
    `<option value="">— Colonne —</option>`,
    ...state.columns.map(c => `<option value="${c.name}">${c.name}</option>`)
  ].join("");

  div.innerHTML = `
    <select class="qb-filter-col">${colOptions}</select>
    <select class="qb-filter-op" style="flex:0 0 auto;width:auto;min-width:90px;">
      <option value="=">=</option>
      <option value="!=">!=</option>
      <option value=">">&gt;</option>
      <option value=">=">&gt;=</option>
      <option value="<">&lt;</option>
      <option value="<=">&lt;=</option>
      <option value="LIKE">contient</option>
    </select>
    <input type="text" class="qb-filter-val" placeholder="Valeur…">
    <button class="btn btn-danger btn-sm qb-btn-remove" title="Supprimer">✕</button>
  `;

  div.querySelector(".qb-filter-col").addEventListener("change", (e) => {
    const colMeta = state.columns.find(c => c.name === e.target.value);
    const type = colMeta?.type?.toString().toUpperCase() || "";
    const input = div.querySelector(".qb-filter-val");
    input.type = isNumericType(type) ? "number" : type.includes("DATE") ? "date" : "text";
  });

  div.querySelector(".qb-btn-remove").addEventListener("click", () => {
    div.remove();
    updateSQLPreview();
  });

  list.appendChild(div);
}

// ===== SQL Preview =====
sqlPreview.addEventListener("input", () => {
  isQueryEdited = true;
  sqlPreview.classList.add("edited");
});

els.resetQueryBtn.addEventListener("click", () => {
  isQueryEdited = false;
  sqlPreview.classList.remove("edited");
  updateSQLPreview();
});

function updateSQLPreview() {
  if (isQueryEdited || !state.tableQuery) return;
  sqlPreview.textContent = buildQuery();
}

// ===== Query Building =====
function buildQuery() {
  const selectedCols = [];
  const groupByCols = [];
  let hasAgg = false;

  document.querySelectorAll(".qb-col-item").forEach((item) => {
    const cb  = item.querySelector(".qb-col-check");
    const agg = item.querySelector(".qb-col-agg");
    if (!cb?.checked) return;
    const col = cb.value;
    const aggVal = agg?.value || "";
    if (aggVal) {
      hasAgg = true;
      selectedCols.push(`${aggVal}("${col}") AS "${aggVal}_${col}"`);
    } else {
      selectedCols.push(`"${col}"`);
      groupByCols.push(`"${col}"`);
    }
  });

  if (selectedCols.length === 0) selectedCols.push("*");

  let sql = `SELECT ${selectedCols.join(", ")} FROM ${state.tableQuery}`;

  // WHERE
  const conditions = [];
  document.querySelectorAll(".qb-filter-row").forEach((row) => {
    const col = row.querySelector(".qb-filter-col").value;
    const op  = row.querySelector(".qb-filter-op").value;
    const val = row.querySelector(".qb-filter-val").value;
    if (!col || val === "") return;

    const colMeta  = state.columns.find(c => c.name === col);
    const colType  = colMeta?.type?.toString().toUpperCase() || "";
    const escape   = (v) => v.replace(/'/g, "''");

    let fval;
    if (op === "LIKE") {
      fval = `'%${escape(val)}%'`;
    } else if (colType.includes("BOOLEAN")) {
      fval = ["true","1"].includes(val.toLowerCase()) ? "TRUE" : "FALSE";
    } else if (isNumericType(colType)) {
      if (!isNaN(val)) fval = val;
    } else {
      fval = `'${escape(val)}'`;
    }

    if (fval != null) conditions.push(`"${col}" ${op} ${fval}`);
  });

  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
  if (hasAgg && groupByCols.length > 0) sql += ` GROUP BY ${groupByCols.join(", ")}`;

  const sortCol = document.getElementById("qbSortCol")?.value;
  const sortDir = document.getElementById("qbSortDir")?.value || "ASC";
  const limit   = document.getElementById("qbLimit")?.value || "1000";

  if (sortCol) sql += ` ORDER BY "${sortCol}" ${sortDir}`;
  if (limit)   sql += ` LIMIT ${parseInt(limit, 10)}`;

  return sql;
}

// ===== Execute Query =====
els.runBtn.addEventListener("click", async () => {
  if (!state.tableQuery) return;

  const query = sqlPreview.textContent.trim();
  if (!query || query === "SELECT …") return;

  els.runBtn.disabled = true;
  els.runBtn.textContent = "⏳ Exécution…";

  try {
    const result = await state.conn.query(query);
    const rows = result.toArray();
    displayResults(rows);
    scrollToResultsOnMobile();
  } catch (err) {
    console.error(err);
    showQueryError(err.message);
    scrollToResultsOnMobile();
  } finally {
    els.runBtn.disabled = false;
    els.runBtn.textContent = "▶ Exécuter la requête";
  }
});

// ===== Display =====
function toDisplayRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const key in row) {
      out[key] = typeof row[key] === "bigint" ? row[key].toString() : row[key];
    }
    return out;
  });
}

function displayTable(rows) {
  const container = document.getElementById("resultTableContainer");
  if (container._tabulator) { container._tabulator.destroy(); delete container._tabulator; }

  container._tabulator = new Tabulator(container, {
    data: toDisplayRows(rows),
    autoColumns: true,
    autoColumnsDefinitions: (definitions) => {
      return definitions.map(col => ({
        ...col,
        headerFilter: true,
        headerFilterPlaceholder: "…",
        resizable: true,
        tooltip: true,
      }));
    },
    layout: "fitData",
    pagination: "local",
    paginationSize: 25,
    paginationSizeSelector: [25, 50, 100, 500],
    paginationCounter: "rows",
    movableColumns: true,
    placeholder: "<div class='empty-state'><span class='empty-icon'>📭</span><p>Aucune ligne ne correspond aux filtres</p></div>",
  });
}

function displayResults(rows, isPreview = false) {
  const container = document.getElementById("resultTableContainer");

  if (els.resultPlaceholder) els.resultPlaceholder.style.display = "none";

  if (!rows || rows.length === 0) {
    if (container._tabulator) { container._tabulator.destroy(); delete container._tabulator; }
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">📭</span><p>Aucun résultat — essayez d'ajuster vos filtres</p></div>`;
    els.resultActions.style.display = "none";
    return;
  }

  displayTable(rows);

  const colCount = Object.keys(rows[0]).length;
  const rowLabel = rows.length.toLocaleString("fr-FR") + " ligne" + (rows.length > 1 ? "s" : "");
  els.resultCount.textContent = isPreview
    ? `Aperçu — ${rowLabel}`
    : `${rowLabel} · ${colCount} col.`;
  els.resultActions.style.display = "flex";
}

function showQueryError(message) {
  const container = document.getElementById("resultTableContainer");
  if (container._tabulator) { container._tabulator.destroy(); delete container._tabulator; }
  if (els.resultPlaceholder) els.resultPlaceholder.style.display = "none";
  container.innerHTML = `<div class="error-box">❌ Erreur SQL\n\n${message}</div>`;
  els.resultActions.style.display = "none";
}

// ===== Export =====
els.exportExcelBtn.addEventListener("click", async () => {
  if (!state.conn || !state.tableQuery) return;

  els.exportExcelBtn.disabled = true;
  els.exportExcelBtn.textContent = "⏳ Export…";

  try {
    // Récupérer la requête courante et supprimer la clause LIMIT pour tout exporter
    let query = sqlPreview.textContent.trim();
    if (!query || query === "SELECT …") query = buildQuery();
    const fullQuery = query.replace(/\s+LIMIT\s+\d+\s*$/i, "");

    const result = await state.conn.query(fullQuery);
    const rows = toDisplayRows(result.toArray());

    if (rows.length === 0) {
      els.exportExcelBtn.disabled = false;
      els.exportExcelBtn.textContent = "💾 Exporter Excel";
      return;
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Données");
    XLSX.writeFile(wb, `export_${new Date().toISOString().split("T")[0]}.xlsx`);
  } catch (err) {
    console.error("Erreur export:", err);
    alert(`❌ Erreur export : ${err.message}`);
  } finally {
    els.exportExcelBtn.disabled = false;
    els.exportExcelBtn.textContent = "💾 Exporter Excel";
  }
});

// ===== Init =====
(async () => {
  await initDuckDB();
})();
