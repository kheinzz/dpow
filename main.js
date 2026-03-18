import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@latest/+esm";

// ===== État de l'application =====
const state = {
  db: null,
  conn: null,
  fileName: null,
  tableQuery: null, // ex: "parquet_scan('data.parquet')" ou "read_csv_auto('data.csv')"
  columns: [],
  isInitialized: false,
};

// ===== Éléments DOM =====
const elements = {
  fileInput: document.getElementById("fileInput"),
  runBtn: document.getElementById("runQuery"),
  fileStatus: document.getElementById("fileStatus"),
  exportExcelBtn: document.getElementById("exportExcel"),
  // Les anciens éléments statiques sont ignorés au profit du Query Builder dynamique
};

let isQueryEdited = false; // Variable globale pour suivre si l'utilisateur a modifié manuellement l'encart SQL

// Détecter si l'utilisateur modifie manuellement l'encart SQL
const sqlPreview = document.getElementById("sqlPreview");
sqlPreview.addEventListener("input", () => {
  isQueryEdited = true; // L'utilisateur a modifié manuellement l'encart
});

// ===== Initialisation =====
async function initDuckDB() {
  try {
    state.fileStatus = "Initialisation de DuckDB...";
    updateFileStatus("⏳ Initialisation de DuckDB...");

    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

    const worker_url = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], {
        type: "text/javascript",
      }),
    );

    const worker = new Worker(worker_url);
    const logger = new duckdb.ConsoleLogger();
    state.db = new duckdb.AsyncDuckDB(logger, worker);

    await state.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    state.conn = await state.db.connect();

    URL.revokeObjectURL(worker_url);
    state.isInitialized = true;

    console.log("✅ DuckDB-Wasm initialized successfully.");
    updateFileStatus("✅ Prêt - Charger un fichier Parquet");
  } catch (error) {
    console.error("Erreur initialisation DuckDB:", error);
    updateFileStatus("❌ Erreur initialisation DuckDB");
  }
}

// ===== Utilitaires =====
function updateFileStatus(message) {
  if (elements.fileStatus) {
    elements.fileStatus.textContent = message;
  }
}

function clearResults() {
  if (elements.resultTable) {
    elements.resultTable.innerHTML = "";
  }
}

function showError(message, section = "resultTable") {
  console.error(message);
  if (elements[section]) {
    elements[section].innerHTML =
      `<tr><td style="color:red;padding:1rem;">❌ ${message}</td></tr>`;
  }
}
function logMemoryUsage() {
  if (performance && performance.memory) {
    const usedMB = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(2);
    const totalMB = (performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(
      2,
    );
    console.log(`💾 Mémoire utilisée : ${usedMB} MB / ${totalMB} MB`);
  } else {
    console.log(
      "💾 Surveillance de la mémoire non disponible dans ce navigateur.",
    );
  }
}

function isNumericType(typeStr) {
  const numericTypes = [
    "INTEGER",
    "DOUBLE",
    "FLOAT",
    "BIGINT",
    "SMALLINT",
    "TINYINT",
    "DECIMAL",
    "HUGEINT",
    "UINTEGER",
    "UBIGINT",
    "INT",
  ];
  return numericTypes.some((t) => typeStr.includes(t));
}
// Purge de duckdb
async function resetDuckDB() {
  try {
    if (state.conn) {
      // Fermer la connexion existante
      await state.conn.close();
      state.conn = null;
    }

    if (state.db) {
      // Terminer l'instance DuckDB
      await state.db.terminate();
      state.db = null;
    }

    // Réinitialiser DuckDB
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

    const worker_url = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], {
        type: "text/javascript",
      }),
    );

    const worker = new Worker(worker_url);
    const logger = new duckdb.ConsoleLogger();
    state.db = new duckdb.AsyncDuckDB(logger, worker);

    await state.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    state.conn = await state.db.connect();

    URL.revokeObjectURL(worker_url);

    console.log("✅ DuckDB réinitialisé (nouvelle instance créée)");
  } catch (err) {
    console.error(
      "Erreur lors de la réinitialisation complète de DuckDB :",
      err,
    );
  }
}

async function handleUrlLoad() {
  const urlInput = document.getElementById("urlInput");
  if (!urlInput) return;

  const url = urlInput.value.trim();
  if (!url) {
    updateFileStatus("⚠️ Veuillez entrer une URL.");
    return;
  }

  if (!url.toLowerCase().endsWith(".parquet")) {
    updateFileStatus("❌ L'URL doit pointer vers un fichier .parquet.");
    return;
  }

  clearResults();
  try {
    updateFileStatus("⏳ Réinitialisation complète de DuckDB...");
    await resetDuckDB(); // Réinitialiser DuckDB avant de charger un nouveau fichier
    logMemoryUsage();
    updateFileStatus(`⏳ Chargement depuis l'URL...`);

    // DuckDB-Wasm gère le téléchargement
    await state.db.registerFileUrl("data.parquet", url);

    const fileName = url.substring(url.lastIndexOf("/") + 1);
    state.fileName = fileName;
    state.tableQuery = "parquet_scan('data.parquet')";
    updateFileStatus(`✅ Fichier chargé : ${fileName}`);

    await loadColumns();
  } catch (err) {
    console.error("Erreur chargement URL:", err);
    updateFileStatus(`❌ Erreur chargement URL : ${err.message}`);
  }
}

// ===== Gestion des fichiers =====
elements.fileInput.addEventListener("change", async (e) => {
  clearResults();
  const file = e.target.files[0];

  if (!file) {
    updateFileStatus("⚠️ Aucun fichier sélectionné");
    return;
  }

  const isParquet = file.name.toLowerCase().endsWith(".parquet");
  const isCsv = file.name.toLowerCase().endsWith(".csv");

  if (!isParquet && !isCsv) {
    updateFileStatus("❌ Veuillez sélectionner un fichier .parquet ou .csv");
    return;
  }

  try {
    updateFileStatus("⏳ Réinitialisation complète de DuckDB...");
    await resetDuckDB(); // Réinitialiser DuckDB avant de charger un nouveau fichier
    logMemoryUsage();
    updateFileStatus("⏳ Chargement du fichier local...");
    const buffer = await file.arrayBuffer();

    if (buffer.byteLength === 0) {
      throw new Error("Le fichier est vide.");
    }

    if (isParquet) {
      await state.db.registerFileBuffer("data.parquet", new Uint8Array(buffer));
      state.tableQuery = "parquet_scan('data.parquet')";
    } else {
      // isCsv
      await state.db.registerFileBuffer("data.csv", new Uint8Array(buffer));
      state.tableQuery = "read_csv_auto('data.csv')";
    }

    state.fileName = file.name;
    updateFileStatus(`✅ Fichier chargé : ${file.name}`);

    await loadColumns();
  } catch (err) {
    console.error("Erreur chargement fichier:", err);
    updateFileStatus(`❌ Erreur chargement : ${err.message}`);
  }
});

async function loadColumns() {
  try {
    if (!state.conn) {
      throw new Error("Connexion DuckDB non disponible");
    }

    // On utilise LIMIT 0 pour récupérer le schéma sans charger de données, compatible avec parquet et csv
    const query = `SELECT * FROM ${state.tableQuery} LIMIT 0`;
    const result = await state.conn.query(query);

    if (!result.schema || !result.schema.fields) {
      throw new Error("Impossible de récupérer le schéma du fichier");
    }

    state.columns = result.schema.fields;

    // Initialiser le constructeur de requête dynamique
    renderQueryBuilder();

    console.log("✅ Colonnes chargées:", state.columns);
    updateFileStatus(`✅ ${state.columns.length} colonnes détectées`);

    // Charger les 100 premières lignes
    await loadInitialRows();
  } catch (err) {
    console.error("Erreur loadColumns:", err);
    updateFileStatus(`❌ Erreur chargement colonnes : ${err.message}`);
  }
}

async function loadInitialRows() {
  try {
    const query = `SELECT * FROM ${state.tableQuery} LIMIT 100`;
    const result = await state.conn.query(query);
    const rows = result.toArray();

    if (rows.length === 0) {
      console.warn("⚠️ Aucun résultat à afficher.");
      return;
    }

    // Afficher les résultats dans Tabulator
    displayTable(rows);
  } catch (err) {
    console.error("Erreur lors du chargement des premières lignes :", err);
    updateFileStatus(`❌ Erreur chargement lignes : ${err.message}`);
  }
}

function displayTable(rows) {
  const container = document.getElementById("resultTableContainer");

  // Détruire une table existante si elle existe
  if (container._tabulator) {
    container._tabulator.destroy();
  }

  // Convertir les valeurs BigInt en chaînes
  const convertedRows = rows.map((row) => {
    const convertedRow = {};
    for (const key in row) {
      if (typeof row[key] === "bigint") {
        convertedRow[key] = row[key].toString(); // Convertir BigInt en chaîne
      } else {
        convertedRow[key] = row[key];
      }
    }
    return convertedRow;
  });

  // Créer une nouvelle table Tabulator
  const table = new Tabulator(container, {
    data: convertedRows, // Données converties
    autoColumns: true, // Générer automatiquement les colonnes
    layout: "fitData", // Ajuster la largeur des colonnes aux données
    pagination: "local", // Activer la pagination locale
    paginationSize: 10, // Nombre de lignes par page
    movableColumns: true, // Permettre de déplacer les colonnes
    resizableRows: true, // Permettre de redimensionner les lignes
  });

  // Associer la table Tabulator au conteneur pour pouvoir la détruire plus tard
  container._tabulator = table;

  console.log("✅ Table affichée avec Tabulator");
}

// ===== Query Builder Dynamique =====
function renderQueryBuilder() {
  // Trouver l'emplacement pour injecter le builder (avant le bouton Run)
  let container = document.getElementById("queryBuilderContainer");

  if (!container) {
    container = document.createElement("div");
    container.id = "queryBuilderContainer";
    container.className = "qb-container";
    // Insérer avant le bouton Run
    elements.runBtn.parentNode.insertBefore(container, elements.runBtn);

    // Masquer les anciens contrôles s'ils existent encore visuellement
    const oldControls = document.querySelectorAll(
      "select:not(.qb-select), input:not(#fileInput):not(.qb-input)",
    );
    oldControls.forEach((el) => {
      // On essaie de masquer les conteneurs parents des anciens inputs pour nettoyer l'interface
      if (
        el.id &&
        ["aggFunction", "filterColumn", "groupColumn"].includes(el.id)
      ) {
        const parentRow = el.closest(".row");
        if (parentRow) parentRow.style.display = "none";
      }
    });
  }

  container.innerHTML = `
    <div class="qb-section">
      <h3>1. Colonnes à afficher (et agrégations)</h3>
      <div class="qb-columns-grid" id="qbColumnsList"></div>
    </div>

    <div class="qb-section">
      <h3>
        2. Filtres 
        <button class="qb-btn-sm" id="qbAddFilterBtn" style="background:#28a745;color:white;border:none;border-radius:4px;">+ Ajouter un filtre</button>
      </h3>
      <div id="qbFiltersList"></div>
    </div>

    <div class="qb-section">
      <h3>3. Options (Tri & Limite)</h3>
      <div class="row">
        <label>Trier par :</label>
        <select id="qbSortCol" class="qb-input"><option value="">-- Aucun --</option></select>
        <select id="qbSortDir" class="qb-input"><option value="ASC">Croissant</option><option value="DESC">Décroissant</option></select>
        <label style="margin-left:1rem;">Limite :</label>
        <input type="number" id="qbLimit" value="1000" class="qb-input" style="width:80px;">
      </div>
    </div>
  `;

  // Remplir la liste des colonnes
  const colList = document.getElementById("qbColumnsList");
  const sortSelect = document.getElementById("qbSortCol");

  // Ajout de la case "Tout cocher / décocher"
  const selectAllDiv = document.createElement("div");
  selectAllDiv.className = "qb-col-item";
  selectAllDiv.style.borderBottom = "1px solid #eee";
  selectAllDiv.style.marginBottom = "5px";
  selectAllDiv.innerHTML = `<input type="checkbox" id="qbSelectAll" checked> <label for="qbSelectAll" style="font-weight:bold;cursor:pointer;">Tout (dé)sélectionner</label>`;
  colList.appendChild(selectAllDiv);

  selectAllDiv.querySelector("input").addEventListener("change", (e) => {
    const checked = e.target.checked;
    colList
      .querySelectorAll(".qb-col-check")
      .forEach((cb) => (cb.checked = checked));
    updateSQLPreview();
  });

  state.columns.forEach((col) => {
    const name = col.name;
    const type = col.type.toString().toUpperCase();
    const isNum = isNumericType(type);

    // Item de colonne
    const div = document.createElement("div");
    div.className = "qb-col-item";
    div.innerHTML = `
      <input type="checkbox" class="qb-col-check" value="${name}" id="col_${name}" checked>
<label for="col_${name}" style="flex-grow:1;cursor:pointer;font-weight:500;">
  ${name}
  <span style="
    font-size:0.75rem;
    color:#666;
    margin-left:6px;
    background:#eee;
    padding:2px 6px;
    border-radius:4px;
  ">
    ${type}
  </span>
</label>      ${
      isNum
        ? `
        <select class="qb-col-agg" data-col="${name}" style="font-size:0.8rem;padding:2px;">
          <option value="">(Valeur)</option>
          <option value="SUM">Somme</option>
          <option value="AVG">Moyenne</option>
          <option value="MIN">Min</option>
          <option value="MAX">Max</option>
          <option value="COUNT">Compte</option>
        </select>
      `
        : `
        <select class="qb-col-agg" data-col="${name}" style="font-size:0.8rem;padding:2px;">
           <option value="">(Valeur)</option>
           <option value="COUNT">Compte</option>
        </select>
      `
    }
    `;
    colList.appendChild(div);

    // Remplir le tri
    sortSelect.innerHTML += `<option value="${name}">${name}</option>`;
  });

  // Events
  document
    .getElementById("qbAddFilterBtn")
    .addEventListener("click", addFilterRow);
  container.addEventListener("change", updateSQLPreview);
  container.addEventListener("input", updateSQLPreview);

  // Initialiser un filtre vide
  addFilterRow();
  updateSQLPreview();
}

function addFilterRow() {
  const list = document.getElementById("qbFiltersList");
  const div = document.createElement("div");
  div.className = "row qb-filter-row";
  div.style.background = "#f9f9f9";
  div.style.padding = "0.5rem";
  div.style.borderRadius = "4px";

  let colOptions = `<option value="">-- Colonne --</option>`;
  state.columns.forEach(
    (c) => (colOptions += `<option value="${c.name}">${c.name}</option>`),
  );

  div.innerHTML = `
    <select class="qb-filter-col">${colOptions}</select>
    <select class="qb-filter-op">
      <option value="=">=</option>
      <option value="!=">!=</option>
      <option value=">">&gt;</option>
      <option value=">=">&gt;=</option>
      <option value="<">&lt;</option>
      <option value="<=">&lt;=</option>
      <option value="LIKE">Contient (LIKE)</option>
    </select>
    <input type="text" class="qb-filter-val" placeholder="Valeur">
    <button class="qb-btn-remove" style="background:#dc3545;color:white;border:none;border-radius:4px;padding:0.3rem 0.6rem;cursor:pointer;">X</button>
  `;
div.querySelector(".qb-filter-col").addEventListener("change", (e) => {
  const col = e.target.value;
  const input = div.querySelector(".qb-filter-val");

  const colMeta = state.columns.find(c => c.name === col);
  const type = colMeta?.type?.toString().toUpperCase() || "";

  if (isNumericType(type)) {
    input.type = "number";
  } else if (type.includes("DATE")) {
    input.type = "date";
  } else {
    input.type = "text";
  }
});
  div.querySelector(".qb-btn-remove").addEventListener("click", () => {
    div.remove();
    updateSQLPreview();
  });

  list.appendChild(div);
}

function updateSQLPreview() {
  const sqlPreview = document.getElementById("sqlPreview");

  // Ne pas écraser si l'utilisateur a modifié manuellement
  if (isQueryEdited) return;

  const query = buildQuery(); // Génère la requête SQL actuelle
  if (sqlPreview) {
    sqlPreview.textContent = query; // Affiche la requête dans l'encart
  }
}

// ===== Exécution des requêtes =====
elements.runBtn.addEventListener("click", async () => {
  if (!state.tableQuery) {
    updateFileStatus("⚠️ Veuillez d'abord charger un fichier");
    return;
  }

  try {
    clearResults();

    // Récupérer la requête depuis l'encart SQL
    const sqlPreview = document.getElementById("sqlPreview");
    let query = sqlPreview.textContent.trim();

    // Si l'encart est vide, générer une requête automatiquement
    if (!query || query === "SELECT ...") {
      query = buildQuery();
    }

    console.log("SQL:", query);

    const result = await state.conn.query(query);
    const rows = result.toArray();

    displayResults(rows);
  } catch (err) {
    console.error("Erreur requête:", err);
    showError(err.message || "Erreur lors de l'exécution", "resultTable");
  }
});

function buildQuery() {
  // 1. SELECT & GROUP BY Logic
  const selectedCols = [];
  const groupByCols = [];
  let hasAggregation = false;

  const colItems = document.querySelectorAll(".qb-col-item");
  colItems.forEach((item) => {
    const checkbox = item.querySelector(".qb-col-check");
    const aggSelect = item.querySelector(".qb-col-agg");

    if (checkbox && checkbox.checked) {
      const colName = checkbox.value;
      const agg = aggSelect ? aggSelect.value : "";

      if (agg) {
        hasAggregation = true;
        selectedCols.push(`${agg}("${colName}") AS "${agg}_${colName}"`);
      } else {
        selectedCols.push(`"${colName}"`);
        groupByCols.push(`"${colName}"`); // Candidat pour le Group By
      }
    }
  });

  // Fallback si rien n'est sélectionné
  if (selectedCols.length === 0) {
    selectedCols.push("*");
  }

  let query = `SELECT ${selectedCols.join(", ")} FROM ${state.tableQuery}`;

  // 2. WHERE Logic
  const filterRows = document.querySelectorAll(".qb-filter-row");
  const conditions = [];

  filterRows.forEach((row) => {
    const col = row.querySelector(".qb-filter-col").value;
    const op = row.querySelector(".qb-filter-op").value;
    let val = row.querySelector(".qb-filter-val").value;

    if (col && val !== "") {
      // Gestion basique des types (si c'est une chaine, on met des quotes)
      // Note: Pour une vraie robustesse, il faudrait vérifier le type de la colonne dans state.columns
      const colMeta = state.columns.find((c) => c.name === col);
      const colType = colMeta?.type?.toString().toUpperCase() || "";

      function escapeSQL(val) {
        return val.replace(/'/g, "''");
      }

      const isNum = isNumericType(colType);
      const isBool = colType.includes("BOOLEAN");
      const isDate = colType.includes("DATE") || colType.includes("TIME");

      let formattedVal = null;

      if (op === "LIKE") {
        formattedVal = `'%${escapeSQL(val)}%'`;
      } else if (isBool) {
        if (["true", "1"].includes(val.toLowerCase())) formattedVal = "TRUE";
        else if (["false", "0"].includes(val.toLowerCase()))
          formattedVal = "FALSE";
      } else if (isNum) {
        if (!isNaN(val)) formattedVal = val;
      } else if (isDate) {
        formattedVal = `'${escapeSQL(val)}'`;
      } else {
        // STRING (important pour code_insee)
        formattedVal = `'${escapeSQL(val)}'`;
      }

      if (formattedVal !== null) {
        conditions.push(`"${col}" ${op} ${formattedVal}`);
      }
    }
  });

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  // 3. GROUP BY Logic (Automatique)
  if (hasAggregation && groupByCols.length > 0) {
    query += ` GROUP BY ${groupByCols.join(", ")}`;
  }

  // 4. ORDER BY & LIMIT
  const sortCol = document.getElementById("qbSortCol")
    ? document.getElementById("qbSortCol").value
    : "";
  const sortDir = document.getElementById("qbSortDir")
    ? document.getElementById("qbSortDir").value
    : "ASC";
  const limit = document.getElementById("qbLimit")
    ? document.getElementById("qbLimit").value
    : "1000";

  if (sortCol) {
    query += ` ORDER BY "${sortCol}" ${sortDir}`;
  }

  if (limit) {
    query += ` LIMIT ${limit}`;
  }

  return query;
}

function displayResults(rows) {
  const container = document.getElementById("resultTableContainer");

  if (!rows || rows.length === 0) {
    console.warn("📭 Aucun résultat à afficher.");
    updateFileStatus("📭 Aucun résultat à afficher.");

    // Affichage explicite dans la zone de résultat
    if (container) {
      if (container._tabulator) {
        container._tabulator.destroy(); // Nettoyer l'ancien tableau
        delete container._tabulator;
      }
      container.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: #666; background: #fff; border: 1px dashed #ccc; border-radius: 8px;">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">📭</div>
          <strong>Aucun résultat trouvé</strong>
          <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem;">La requête n'a retourné aucune donnée. Essayez d'ajuster vos filtres.</p>
        </div>
      `;
    }
    return;
  }

  // Afficher les résultats dans Tabulator
  displayTable(rows);
}

// ===== Export Excel =====
elements.exportExcelBtn.addEventListener("click", () => {
  const container = document.getElementById("resultTableContainer");

  if (!container._tabulator) {
    alert("⚠️ Aucun résultat à exporter");
    return;
  }

  try {
    // Utiliser Tabulator pour exporter les données au format Excel
    container._tabulator.download(
      "xlsx",
      `export_${new Date().toISOString().split("T")[0]}.xlsx`,
    );
    console.log("✅ Export Excel réussi");
  } catch (err) {
    console.error("Erreur export:", err);
    alert(`❌ Erreur export : ${err.message}`);
  }
});

// ===== Lancement =====
(async () => {
  console.log("🚀 Démarrage de l'application...");

  // Ajout dynamique des contrôles pour le chargement par URL
  const fileInputParent = elements.fileInput.parentNode;
  if (fileInputParent) {
    // Mettre à jour l'input de fichier existant pour accepter le CSV
    elements.fileInput.accept = ".parquet, .csv";
    const fileLabel = document.querySelector('label[for="fileInput"]');
    if (fileLabel)
      fileLabel.textContent = "Charger un fichier local (.parquet ou .csv) :";

    // Le chargement URL est désactivé pour le moment
    // document.getElementById('loadUrlBtn')?.addEventListener('click', handleUrlLoad);
  }

  await initDuckDB();
})();
