let instrumentSearchResults = [];
let selectedInstrument = null;
let chartRange = '3mo';

const token = localStorage.getItem('mic_token');
const role = localStorage.getItem('mic_role');
const name = localStorage.getItem('mic_name');

if (!token) {
  window.location.href = '/';
}

const pageMeta = {
  portfolio: {
    title: 'Portfolio',
    subtitle: 'Positions détenues, poids, valorisation et performances par ligne.'
  },
  transactions: {
    title: 'Transactions',
    subtitle: 'Historique des achats, ventes, dépôts, dividendes et frais.'
  },
  documents: {
    title: 'Documents',
    subtitle: 'Espace documentaire interne du Mosaique Investment Club.'
  }
};

function formatCurrency(value, currency = 'EUR') {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(Number(value || 0));
}
function formatPct(v) {
  const num = Number(v || 0);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
}
function setUserContext() {
  const el = document.getElementById('user-context');
  if (el) el.textContent = `${name || 'Utilisateur'} · ${role === 'board' ? 'Board' : 'Membre'}`;
  document.querySelectorAll('[data-board-only]').forEach((item) => {
    item.style.display = role === 'board' ? '' : 'none';
  });
}
function switchPage(page) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `${page}-page`));
  document.getElementById('page-title').textContent = pageMeta[page].title;
  document.getElementById('page-subtitle').textContent = pageMeta[page].subtitle;
}
function serializeToCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return [headers.join(';'), ...rows.map((row) => headers.map((h) => esc(row[h])).join(';'))].join('\n');
}
async function exportTransactionsCsv() {
  const response = await fetch('/api/data', { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json();
  const rows = (data.portfolio.transactions || []).map((t) => ({
    date: t.date,
    asset: t.asset,
    type: t.type,
    quantity: t.quantity ?? '',
    amount: t.amount,
    fees: t.fees,
    currency: t.currency || 'EUR',
    note: t.note || ''
  }));
  const blob = new Blob([serializeToCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mosaique-transactions.csv';
  link.click();
  URL.revokeObjectURL(url);
}
async function loadData() {
  const response = await fetch('/api/data', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    localStorage.clear();
    window.location.href = '/';
    return;
  }
  const data = await response.json();
  const portfolio = data.portfolio;
  renderPortfolioSummary(portfolio.summary, portfolio.liveMeta);
  renderPortfolio(portfolio.positions);
  renderTransactions(portfolio.transactions);
  renderDocuments(portfolio.documents);
  renderAllocation(portfolio.allocation || []);
  await loadChart(chartRange);
}
function renderPortfolioSummary(summary, liveMeta) {
  document.getElementById('metric-total-value').textContent = formatCurrency(summary.totalValue);
  document.getElementById('metric-unrealized').textContent = `${summary.unrealizedPnL >= 0 ? '+ ' : '- '}${formatCurrency(Math.abs(summary.unrealizedPnL))}`;
  document.getElementById('metric-portfolio-value').textContent = formatCurrency(summary.positionsValue || 0);
  document.getElementById('metric-cash').textContent = formatCurrency(summary.cashAvailable);
  const badge = document.getElementById('market-badge');
  if (badge && liveMeta?.updatedAt) badge.textContent = `Dernière mise à jour : ${new Date(liveMeta.updatedAt).toLocaleString('fr-FR')}`;
}
function renderAllocation(allocation) {
  const box = document.getElementById('allocation-list');
  box.innerHTML = allocation.map((a) => `
    <div class="mini-item compact">
      <div><strong>${a.label}</strong><span>Poids du portefeuille</span></div>
      <strong>${a.value}%</strong>
    </div>`).join('');
}


function renderPortfolio(positions, liveMeta) {
  const tbody = document.getElementById('portfolio-body');

  tbody.innerHTML = positions.map((p) => `
    <tr>
      <td>
        <div class="asset">
          <div class="asset-badge">${(p.ticker || '').slice(0, 2).toUpperCase()}</div>
          <div>
            <div class="asset-name">${p.name}</div>
            <div class="asset-sub">
              ${p.ticker} · ${p.type} · ${p.currency}${p.isin ? ` · ${p.isin}` : ''}${p.yahooSymbol ? ` · ${p.yahooSymbol}` : ''}
            </div>
          </div>
        </div>
      </td>
      <td class="nowrap">${p.quantity}</td>
      <td class="nowrap">${formatCurrency(p.avgPrice, p.currency)}</td>
      <td class="nowrap">${formatCurrency(p.currentPrice, p.currency)}</td>
      <td class="nowrap">${formatCurrency(p.value, p.currency)}</td>
      <td class="${Number(p.performancePct) >= 0 ? 'up' : 'down'} nowrap">${formatPct(p.performancePct)}</td>
      <td class="nowrap">${p.weight}%</td>
      <td class="nowrap">
        ${typeof p.dayChangePct === 'number'
          ? `<span class="${Number(p.dayChangePct) >= 0 ? 'up' : 'down'}">${formatPct(p.dayChangePct)}</span>`
          : '-'}
      </td>
      <td data-board-only>
        ${role === 'board'
          ? `<button class="small-btn danger" onclick="deletePosition(${p.id})">Supprimer</button>`
          : ''}
      </td>
    </tr>
  `).join('');

  const subtitle = document.getElementById('page-subtitle');
  if (subtitle && document.getElementById('portfolio-page')?.classList.contains('active') && liveMeta?.updatedAt) {
    const when = new Date(liveMeta.updatedAt).toLocaleString('fr-FR');
    subtitle.textContent = `Positions détenues, poids, valorisation et performances par ligne. Dernière mise à jour : ${when}.`;
  }
}


function renderTransactions(transactions) {
  const tbody = document.getElementById('transactions-body');
  tbody.innerHTML = transactions.map((t) => `
    <tr>
      <td>${new Date(t.date).toLocaleDateString('fr-FR')}</td>
      <td>${t.asset}</td>
      <td><span class="tag">${t.type}</span></td>
      <td>${t.quantity ?? '-'}</td>
      <td>${formatCurrency(t.amount, t.currency || 'EUR')}</td>
      <td>${formatCurrency(t.fees || 0, t.currency || 'EUR')}</td>
      <td>${t.note || '-'}</td>
    </tr>`).join('');
}
function renderDocuments(documents) {
  const grid = document.getElementById('documents-grid');
  if (!documents || !documents.length) {
    grid.innerHTML = `<div class="empty-documents">Aucun document disponible pour le moment.</div>`;
    return;
  }
  grid.innerHTML = documents.map((d) => `
    <article class="doc-card">
      <div class="doc-card-top">
        <small>${d.category || 'Document'}</small>
        <h4>${d.title}</h4>
        <p>${d.description || 'Aucune description renseignée.'}</p>
        <div class="doc-meta">
          ${d.uploadedBy ? `Ajouté par ${d.uploadedBy}` : ''}
          ${d.uploadedAt ? `${d.uploadedBy ? ' • ' : ''}${d.uploadedAt}` : ''}
          ${d.fileName ? `${(d.uploadedBy || d.uploadedAt) ? ' • ' : ''}${d.fileName}` : ''}
        </div>
      </div>
      <div class="doc-card-actions">
        <button class="small-btn" onclick="openDocument(${d.id})">Ouvrir</button>
        ${role === 'board' ? `<button class="small-btn danger" onclick="deleteDocument(${d.id})">Supprimer</button>` : `<span class="small-btn ghost">Supprimer</span>`}
      </div>
    </article>`).join('');
}
function buildPolyline(values, width, height, padding) {
  const validValues = values.filter((v) => typeof v === 'number');
  if (!validValues.length) return '';
  const min = Math.min(...validValues);
  const max = Math.max(...validValues);
  const range = max - min || 1;
  return values.map((value, index) => {
    const x = padding + (index * (width - padding * 2)) / Math.max(values.length - 1, 1);
    const y = height - padding - (((value ?? min) - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  }).join(' ');
}
function renderChart(chartData) {
  const container = document.getElementById('chart-wrapper');
  const width = 960, height = 340, padding = 22;
  const portfolioLine = buildPolyline(chartData.portfolioSeries.map((p) => p.value), width, height, padding);
  const assetLines = chartData.assetSeries.map((series, idx) => {
    const points = buildPolyline(series.values.map((v) => v.value), width, height, padding);
    const classes = ['chart-line-alt-1', 'chart-line-alt-2', 'chart-line-alt-3', 'chart-line-alt-4'];
    return `<polyline class="chart-line ${classes[idx % classes.length]}" points="${points}" fill="none"></polyline>`;
  }).join('');
  const labels = chartData.assetSeries.map((series, idx) => {
    const classes = ['legend-dot alt-1', 'legend-dot alt-2', 'legend-dot alt-3', 'legend-dot alt-4'];
    return `<div class="legend-item"><span class="${classes[idx % classes.length]}"></span><span>${series.ticker}</span></div>`;
  }).join('');

  container.innerHTML = `
    <div class="chart-card-shell">
      <svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="none">
        <polyline class="chart-line-main" points="${portfolioLine}" fill="none"></polyline>
        ${assetLines}
      </svg>
      <div class="chart-legend">
        <div class="legend-item"><span class="legend-dot main"></span><span>Portefeuille total</span></div>
        ${labels}
      </div>
    </div>`;
}
async function loadChart(range) {
  chartRange = range;
  document.querySelectorAll('.range-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.range === range));
  const container = document.getElementById('chart-wrapper');
  container.innerHTML = `<div class="empty-documents">Chargement du graphique…</div>`;
  try {
    const response = await fetch(`/api/chart-data?range=${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Erreur graphique');
    renderChart(data);
  } catch (error) {
    container.innerHTML = `<div class="empty-documents">Graphique indisponible : ${error.message}</div>`;
  }
}
async function searchInstruments() {
  if (role !== 'board') return;
  const q = document.getElementById('instrument-query')?.value?.trim();
  const resultsBox = document.getElementById('instrument-results');
  if (!q || q.length < 2) {
    resultsBox.innerHTML = '<div class="mini-item">Tape au moins 2 caractères.</div>';
    return;
  }
  resultsBox.innerHTML = '<div class="mini-item">Recherche en cours…</div>';
  const response = await fetch(`/api/search-instruments?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json();
  if (!response.ok) {
    resultsBox.innerHTML = `<div class="mini-item">Erreur : ${data.message || 'Recherche impossible'}</div>`;
    return;
  }
  instrumentSearchResults = data.results || [];
  if (!instrumentSearchResults.length) {
    resultsBox.innerHTML = '<div class="mini-item">Aucun résultat trouvé.</div>';
    return;
  }
  resultsBox.innerHTML = instrumentSearchResults.map((item, index) => `
  <div class="mini-item result-item" onclick="selectInstrument(${index})">
    <div>
      <strong>${item.name}</strong>
      <span>
        ${item.symbol} · ${item.type} · ${item.exchange || '-'}
        ${item.currency ? ' · ' + item.currency : ''}
        ${item.isin ? ' · ' + item.isin : ''}
        ${item.currentPrice != null ? ' · Prix actuel : ' + item.currentPrice + ' ' + (item.currency || '') : ' · Prix indisponible'}
      </span>
    </div>
    <button class="small-btn">Choisir</button>
  </div>
`).join('');
}
function selectInstrument(index) {
  selectedInstrument = instrumentSearchResults[index] || null;
  const el = document.getElementById('selected-instrument');

  if (!selectedInstrument) {
    el.textContent = 'Aucun instrument sélectionné';
    return;
  }

  el.textContent = `Sélectionné : ${selectedInstrument.name} · ${selectedInstrument.symbol}${selectedInstrument.isin ? ' · ' + selectedInstrument.isin : ''}`;

  if (selectedInstrument.currentPrice != null) {
    document.getElementById('position-avg-price').value = selectedInstrument.currentPrice;
  }
}
async function addSelectedPosition() {
  if (role !== 'board') return;
  if (!selectedInstrument) return alert('Choisis d’abord un instrument.');
  const quantity = Number(document.getElementById('position-quantity')?.value || 0);
  const avgPrice = Number(document.getElementById('position-avg-price')?.value || 0);
  if (!quantity || quantity <= 0) return alert('Entre une quantité valide.');
  if (!avgPrice || avgPrice <= 0) return alert('Entre un prix moyen valide.');
  const payload = {
    name: selectedInstrument.name,
    ticker: selectedInstrument.symbol,
    yahooSymbol: selectedInstrument.symbol,
    type: selectedInstrument.type || 'Autre',
    currency: selectedInstrument.currency || 'EUR',
    quantity,
    avgPrice,
    isin: selectedInstrument.isin || ''
  };
  const response = await fetch('/api/positions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) return alert(data.message || 'Impossible d’ajouter la position');
  alert('Position ajoutée avec succès');
  selectedInstrument = null;
  instrumentSearchResults = [];
  document.getElementById('instrument-query').value = '';
  document.getElementById('position-quantity').value = '';
  document.getElementById('position-avg-price').value = '';
  document.getElementById('instrument-results').innerHTML = '';
  document.getElementById('selected-instrument').textContent = 'Aucun instrument sélectionné';
  await loadData();
  switchPage('portfolio');
}
async function addTransaction() {
  if (role !== 'board') return;
  const payload = {
    date: document.getElementById('tx-date').value || new Date().toISOString().slice(0, 10),
    asset: document.getElementById('tx-asset').value.trim(),
    ticker: document.getElementById('tx-ticker').value.trim(),
    type: document.getElementById('tx-type').value,
    quantity: document.getElementById('tx-quantity').value === '' ? null : Number(document.getElementById('tx-quantity').value),
    amount: Number(document.getElementById('tx-amount').value || 0),
    fees: Number(document.getElementById('tx-fees').value || 0),
    note: document.getElementById('tx-note').value.trim()
  };
  const response = await fetch('/api/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) return alert(data.message || 'Impossible d’ajouter la transaction');
  document.getElementById('tx-asset').value = '';
  document.getElementById('tx-ticker').value = '';
  document.getElementById('tx-quantity').value = '';
  document.getElementById('tx-amount').value = '';
  document.getElementById('tx-fees').value = '';
  document.getElementById('tx-note').value = '';
  await loadData();
  switchPage('transactions');
}

async function uploadDocument() {
  if (role !== 'board') return;
  const title = document.getElementById('doc-title').value.trim();
  const category = document.getElementById('doc-category').value.trim() || 'Document';
  const description = document.getElementById('doc-description').value.trim();
  const content = document.getElementById('doc-content')?.value.trim() || '';
  const fileInput = document.getElementById('doc-file');
  const file = fileInput.files[0];
  if (!title) return alert('Entre un titre de document.');
  if (!file && !content) return alert('Choisis un fichier ou écris un contenu.');
  const formData = new FormData();
  formData.append('title', title);
  formData.append('category', category);
  formData.append('description', description);
  if (content) formData.append('content', content);
  if (file) formData.append('file', file);
  const response = await fetch('/api/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData
  });
  const data = await response.json();
  if (!response.ok) return alert(data.message || 'Erreur lors de l’ajout du document');
  document.getElementById('doc-title').value = '';
  document.getElementById('doc-category').value = 'Reporting';
  document.getElementById('doc-description').value = '';
  const contentEl = document.getElementById('doc-content');
  if (contentEl) contentEl.value = '';
  document.getElementById('doc-file').value = '';
  alert('Document ajouté');
  await loadData();
  switchPage('documents');
}

async function openDocument(id) {
  try {
    const response = await fetch(`/documents/${id}/file`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      alert(data.message || 'Impossible de télécharger le document');
      return;
    }

    const blob = await response.blob();

    let fileName = `document-${id}`;
    const disposition = response.headers.get('Content-Disposition');

    if (disposition) {
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match && match[1]) {
        fileName = match[1];
      }
    }

    const fileURL = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = fileURL;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(fileURL);
  } catch (error) {
    console.error(error);
    alert('Erreur lors du téléchargement du document');
  }
}
async function deleteDocument(id) {
  if (role !== 'board') return;
  if (!window.confirm('Supprimer ce document ?')) return;
  const response = await fetch(`/api/documents/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json();
  if (!response.ok) return alert(data.message || 'Erreur lors de la suppression');
  await loadData();
}
async function deletePosition(id) {
  if (role !== 'board') return;
  if (!window.confirm('Supprimer cette position ?')) return;
  const response = await fetch(`/api/positions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (response.ok) await loadData();
}
function logout() {
  localStorage.clear();
  window.location.href = '/';
}
window.searchInstruments = searchInstruments;
window.selectInstrument = selectInstrument;
window.addSelectedPosition = addSelectedPosition;
window.addTransaction = addTransaction;
window.uploadDocument = uploadDocument;
window.openDocument = openDocument;
window.deleteDocument = deleteDocument;
window.deletePosition = deletePosition;
window.logout = logout;
window.exportTransactionsCsv = exportTransactionsCsv;
window.loadChart = loadChart;

document.addEventListener('DOMContentLoaded', async () => {
  setUserContext();
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchPage(btn.dataset.page)));
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
  await loadData();
  setInterval(loadData, 600000);
});