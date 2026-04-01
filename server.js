const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.MIC_SECRET || 'mosaique_secret_key_change_this';
const DB_FILE = path.join(__dirname, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

let yahooFinance = null;

async function getYahooFinance() {
  if (!yahooFinance) {
    const mod = await import('yahoo-finance2');
    const YahooFinance = mod.default;
    yahooFinance = new YahooFinance();
  }
  return yahooFinance;
}

const ETF_ALIASES = {
  IE00B3XXRP09: {
    symbol: 'VUAA.L',
    name: 'Vanguard S&P 500 UCITS ETF USD Accumulation',
    type: 'ETF',
    exchange: 'LSE',
    currency: 'EUR',
    isin: 'IE00B3XXRP09'
  },
  IE00B02KXL92: {
    symbol: 'DJMC.SW',
    name: 'iShares EURO STOXX Mid UCITS ETF',
    type: 'ETF',
    exchange: 'SWX',
    currency: 'EUR',
    isin: 'IE00B02KXL92'
  },
  IE00B0M63730: {
    symbol: 'IFFF.AS',
    name: 'iShares MSCI AC Far East ex-Japan UCITS ETF USD',
    type: 'ETF',
    exchange: 'AMS',
    currency: 'EUR',
    isin: 'IE00B0M63730'
  }
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safeBase = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safeBase}`);
    }
  }),
  limits: { fileSize: 12 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({ message: 'Token manquant' });
  }

  const token = header.split(' ')[1];

  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Token invalide' });
  }
}

function boardOnly(req, res, next) {
  if (req.user.role !== 'board') {
    return res.status(403).json({ message: 'Accès réservé au board' });
  }
  next();
}

function nextId(items) {
  return items.length ? Math.max(...items.map((item) => Number(item.id || 0))) + 1 : 1;
}

function resolveYahooSymbol(position) {
  return position.yahooSymbol || position.ticker;
}

function sanitizeText(value) {
  return String(value || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}


async function tryYahooQuote(symbol) {
  try {
    if (!symbol) return null;

    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Yahoo chart HTTP ${response.status}`);
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;

    if (!meta) return null;

    const currentPrice =
      typeof meta.regularMarketPrice === 'number'
        ? round(meta.regularMarketPrice)
        : typeof meta.previousClose === 'number'
        ? round(meta.previousClose)
        : null;

    return {
      symbol: meta.symbol || symbol,
      name:
        meta.shortName ||
        meta.longName ||
        meta.instrumentType ||
        symbol,
      type: meta.instrumentType || 'Instrument',
      exchange: meta.exchangeName || meta.fullExchangeName || '',
      currency: meta.currency || '',
      currentPrice
    };
  } catch (err) {
    console.error('CHART QUOTE ERROR', symbol, err.message);
    return null;
  }
}

async function enrichPositionWithLiveData(position) {
  const yahooSymbol = resolveYahooSymbol(position);
  const quantity = Number(position.quantity || 0);
  const avgPrice = Number(position.avgPrice || 0);

  try {
    if (!yahooSymbol) {
      throw new Error('Symbole Yahoo manquant');
    }

    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m&includePrePost=true`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Yahoo HTTP ${response.status}`);
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;

    const livePrice =
      meta?.regularMarketPrice ??
      meta?.previousClose ??
      null;

    if (typeof livePrice !== 'number' || Number.isNaN(livePrice)) {
      throw new Error('Prix live indisponible');
    }

    const previousClose =
      typeof meta?.previousClose === 'number'
        ? round(meta.previousClose)
        : null;

    const dayChangePct =
      typeof livePrice === 'number' &&
      typeof previousClose === 'number' &&
      previousClose !== 0
        ? round(((livePrice - previousClose) / previousClose) * 100)
        : null;

    const value = round(quantity * livePrice);
    const invested = quantity * avgPrice;
    const pnlEuro = round(value - invested);
    const performancePct = invested > 0 ? round((pnlEuro / invested) * 100) : 0;

    return {
      ...position,
      yahooSymbol,
      currentPrice: round(livePrice),
      previousClose,
      dayChangePct,
      value,
      pnlEuro,
      performancePct,
      marketStatus: 'LIVE'
    };
  } catch (error) {
    console.error(`Erreur live pour ${yahooSymbol}:`, error.message);

    const fallbackPrice = Number(position.currentPrice || position.avgPrice || 0);
    const fallbackValue = round(quantity * fallbackPrice);
    const invested = quantity * avgPrice;

    return {
      ...position,
      yahooSymbol,
      currentPrice: fallbackPrice,
      value: fallbackValue,
      pnlEuro: round(fallbackValue - invested),
      performancePct: invested > 0 ? round(((fallbackValue - invested) / invested) * 100) : 0,
      marketStatus: 'ERROR',
      marketError: error.message
    };
  }
}

function formatDocForClient(doc) {
  if (doc.storedName) {
    return {
      ...doc,
      url: `/documents/${doc.id}/file`,
      kind: 'file'
    };
  }

  return {
    ...doc,
    url: `/documents/${doc.id}/view`,
    kind: 'note'
  };
}

function computeDerivedSummary(portfolio, positions) {
  const cash = portfolio.cash || {};
  const positionsValue = round(positions.reduce((sum, p) => sum + Number(p.value || 0), 0));
  const investedCapital = round(
    positions.reduce((sum, p) => sum + Number(p.quantity || 0) * Number(p.avgPrice || 0), 0)
  );
  const unrealizedPnL = round(positions.reduce((sum, p) => sum + Number(p.pnlEuro || 0), 0));
  const totalCashApprox = round(Number(cash.eur || 0) + Number(cash.usd || 0));
  const totalValue = round(positionsValue + totalCashApprox);
  const totalQuantity = round(
    positions.reduce((sum, p) => sum + Number(p.quantity || 0), 0),
    4
  );

  const existingSummary = portfolio.summary || {};
  const allocationMap = {};

  positions.forEach((position) => {
    const label = position.type || 'Autre';
    allocationMap[label] = (allocationMap[label] || 0) + Number(position.value || 0);
  });

  if (totalCashApprox > 0) {
    allocationMap.Cash = totalCashApprox;
  }

  const allocation = Object.entries(allocationMap)
    .map(([label, amount]) => ({
      label,
      value: totalValue > 0 ? round((amount / totalValue) * 100) : 0
    }))
    .sort((a, b) => b.value - a.value);

  const totalWeightBase = positionsValue || 1;
  const weightedPositions = positions.map((position) => ({
    ...position,
    weight: round((Number(position.value || 0) / totalWeightBase) * 100)
  }));

  return {
    positions: weightedPositions,
    allocation,
    summary: {
      ...existingSummary,
      totalValue,
      positionsValue,
      cashAvailable: totalCashApprox,
      totalQuantity,
      unrealizedPnL,
      totalPerformanceEuro: round(Number(existingSummary.realizedPnL || 0) + unrealizedPnL),
      totalPerformancePct: investedCapital > 0 ? round((unrealizedPnL / investedCapital) * 100) : 0
    }
  };
}

async function buildLivePortfolio(portfolio) {
  const livePositions = await Promise.all((portfolio.positions || []).map(enrichPositionWithLiveData));
  const derived = computeDerivedSummary(portfolio, livePositions);

  return {
    ...portfolio,
    positions: derived.positions,
    allocation: derived.allocation,
    documents: (portfolio.documents || []).map(formatDocForClient),
    summary: derived.summary,
    liveMeta: {
      updatedAt: new Date().toISOString(),
      positionsUpdated: livePositions.filter((p) => p.marketStatus !== 'ERROR').length,
      totalPositions: livePositions.length
    }
  };
}

async function getHistoricalSeriesForSymbol(symbol, range = '3mo') {
  if (!symbol) return [];

  if (/^[A-Z]{2}[A-Z0-9]{10}$/i.test(symbol)) return [];
  if (/^0P[0-9A-Z]+$/i.test(symbol)) return [];

  const interval = '1d';

  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${interval}&includePrePost=false`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Yahoo HTTP ${response.status}`);
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];

    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];

    const series = [];

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const close = closes[i];

      if (typeof ts === 'number' && typeof close === 'number' && !Number.isNaN(close)) {
        series.push({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          close: round(close, 4)
        });
      }
    }

    return series;
  } catch (error) {
    console.error(`Historique Yahoo impossible pour ${symbol}:`, error.message);
    return [];
  }
}

function normalizeSeriesPoints(seriesMap) {
  const datesSet = new Set();

  Object.values(seriesMap).forEach((arr) => {
    arr.forEach((point) => datesSet.add(point.date));
  });

  const dates = Array.from(datesSet).sort();
  const normalized = {};

  for (const [key, arr] of Object.entries(seriesMap)) {
    let last = null;
    const byDate = new Map(arr.map((item) => [item.date, item.close]));

    normalized[key] = dates.map((date) => {
      if (byDate.has(date)) {
        last = byDate.get(date);
      }
      return { date, close: last };
    });
  }

  return { dates, normalized };
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = readDB();

  const user = db.users.find(
    (u) =>
      u.username === String(username || '').trim() &&
      u.password === String(password || '')
  );

  if (!user) {
    return res.status(401).json({ message: 'Identifiant ou mot de passe incorrect' });
  }

  const token = jwt.sign(
    {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role
    },
    SECRET,
    { expiresIn: '8h' }
  );

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role
    }
  });
});

app.get('/api/data', auth, async (_req, res) => {
  try {
    const db = readDB();
    const portfolio = await buildLivePortfolio(db.portfolio);
    res.json({ portfolio });
  } catch (error) {
    res.status(500).json({
      message: 'Impossible de charger les données live',
      error: error.message
    });
  }
});

async function yahooSearchFallback(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Yahoo search HTTP ${response.status}`);
  }

  const data = await response.json();

  return (data.quotes || [])
    .filter((item) => item && item.symbol)
    .map((item) => ({
      symbol: item.symbol,
      name: item.shortname || item.longname || item.symbol,
      type: item.quoteType || 'Instrument',
      exchange: item.exchange || item.exchDisp || '',
      currency: item.currency || '',
      currentPrice:
        typeof item.regularMarketPrice === 'number'
          ? round(item.regularMarketPrice)
          : typeof item.navPrice === 'number'
          ? round(item.navPrice)
          : typeof item.previousClose === 'number'
          ? round(item.previousClose)
          : null
    }));
}

app.get('/api/search-instruments', auth, boardOnly, async (req, res) => {
  const q = String(req.query.q || '').trim();

  if (q.length < 2) {
    return res.status(400).json({ message: 'Recherche trop courte' });
  }

  const normalizedQ = normalizeSearchText(q);

  try {
    const aliasResults = Object.entries(ETF_ALIASES)
      .filter(([isin, item]) => {
        const isinText = normalizeSearchText(isin);
        const symbolText = normalizeSearchText(item.symbol);
        const nameText = normalizeSearchText(item.name);

        return (
          isinText.includes(normalizedQ) ||
          symbolText.includes(normalizedQ) ||
          nameText.includes(normalizedQ)
        );
      })
      .map(([isin, item]) => ({
        symbol: item.symbol,
        name: item.name,
        type: item.type,
        exchange: item.exchange,
        currency: item.currency,
        isin
      }));

    if (ETF_ALIASES[normalizedQ]) {
      const item = ETF_ALIASES[normalizedQ];
      return res.json({
        results: [{
          symbol: item.symbol,
          name: item.name,
          type: item.type,
          exchange: item.exchange,
          currency: item.currency,
          isin: item.isin
        }]
      });
    }

    let quotes = [];

    try {
      quotes = await yahooSearchFallback(q);
    } catch (error) {
      console.error('Yahoo HTTP search error:', error.message);
      quotes = [];
    }

    const exactCandidates = [q, normalizedQ];

    if (/^[A-Z0-9.\-=/]{2,20}$/.test(normalizedQ)) {
      for (const candidate of exactCandidates) {
        const exactQuote = await tryYahooQuote(candidate);
        if (exactQuote) {
          quotes.unshift(exactQuote);
          break;
        }
      }
    }

    const merged = [...aliasResults, ...quotes].reduce((acc, item) => {
      const key = `${item.symbol}|${item.name}`;
      if (!acc.some((x) => `${x.symbol}|${x.name}` === key)) {
        acc.push(item);
      }
      return acc;
    }, []);

    const limited = merged.slice(0, 8);

    const enriched = await Promise.all(
      limited.map(async (item) => {
        const live = await tryYahooQuote(item.symbol);

        return {
          ...item,
          currentPrice: live?.currentPrice ?? item.currentPrice ?? null,
          currency: live?.currency || item.currency || '',
          exchange: live?.exchange || item.exchange || '',
          type: live?.type || item.type || 'Instrument',
          name: live?.name || item.name || item.symbol
        };
      })
    );

    if (!enriched.length) {
      return res.status(404).json({
        message: 'Aucun instrument trouvé'
      });
    }

    return res.json({
      results: enriched
    });
  } catch (error) {
    console.error('Recherche instrument impossible:', error);
    res.status(500).json({
      message: 'Recherche instrument impossible',
      error: error.message
    });
  }
});

app.get('/api/chart-data', auth, async (req, res) => {
  try {
    const db = readDB();
    const range = String(req.query.range || '3mo');

    const positions = Array.isArray(db.portfolio?.positions) ? db.portfolio.positions : [];

    if (!positions.length) {
      return res.json({
        range,
        portfolioSeries: [],
        assetSeries: []
      });
    }

    const days = range === '6mo' ? 180 : range === '1mo' ? 30 : 90;
    const count = Math.min(days, 30);

    const buildFallbackSeries = (price) => {
      return Array.from({ length: count }, (_, i) => {
        const date = new Date(
          Date.now() - (count - 1 - i) * 24 * 60 * 60 * 1000
        ).toISOString().slice(0, 10);

        return {
          date,
          close: round(price || 0)
        };
      });
    };

    const assetSeries = [];

    for (const position of positions) {
      const symbol = String(position.yahooSymbol || position.ticker || '').trim();
      const quantity = Number(position.quantity || 0);
      const fallbackPrice = Number(position.currentPrice || position.avgPrice || 0);

      let history = [];

      if (symbol) {
        try {
          history = await getHistoricalSeriesForSymbol(symbol, range);
        } catch (error) {
          console.error(`Historique Yahoo impossible pour ${symbol}:`, error.message);
        }
      }

      if (!history.length) {
        history = buildFallbackSeries(fallbackPrice);
      }

      assetSeries.push({
        ticker: position.ticker || symbol || 'N/A',
        symbol: symbol || position.ticker || 'N/A',
        name: position.name || position.ticker || symbol || 'Instrument',
        values: history.map((point) => ({
          date: point.date,
          value: round(Number(point.close || 0) * quantity)
        }))
      });
    }

    if (!assetSeries.length) {
      return res.json({
        range,
        portfolioSeries: [],
        assetSeries: []
      });
    }

    const dateMap = new Map();

    assetSeries.forEach((asset) => {
      asset.values.forEach((point) => {
        if (!dateMap.has(point.date)) {
          dateMap.set(point.date, 0);
        }
        dateMap.set(point.date, round(dateMap.get(point.date) + Number(point.value || 0)));
      });
    });

    const portfolioSeries = Array.from(dateMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, value]) => ({
        date,
        value: round(value)
      }));

    res.json({
      range,
      portfolioSeries,
      assetSeries
    });
  } catch (error) {
    console.error('Impossible de charger le graphique:', error);
    res.status(500).json({
      message: 'Impossible de charger le graphique',
      error: error.message
    });
  }
});

app.post('/api/positions', auth, boardOnly, (req, res) => {
  const db = readDB();
  const payload = req.body || {};

  const position = {
    id: nextId(db.portfolio.positions),
    name: String(payload.name || '').trim(),
    ticker: String(payload.ticker || '').trim().toUpperCase(),
    yahooSymbol: String(payload.yahooSymbol || payload.ticker || '').trim(),
    type: String(payload.type || 'Autre').trim(),
    currency: String(payload.currency || 'EUR').trim().toUpperCase(),
    quantity: Number(payload.quantity || 0),
    avgPrice: Number(payload.avgPrice || 0),
    isin: String(payload.isin || '').trim().toUpperCase()
  };

  if (!position.name || !position.ticker || position.quantity <= 0 || position.avgPrice <= 0) {
    return res.status(400).json({ message: 'Données de position invalides' });
  }

  db.portfolio.positions.push(position);
  writeDB(db);

  res.json({
    message: 'Position ajoutée',
    position
  });
});

app.delete('/api/positions/:id', auth, boardOnly, (req, res) => {
  const db = readDB();
  const id = Number(req.params.id);

  db.portfolio.positions = db.portfolio.positions.filter((p) => Number(p.id) !== id);
  writeDB(db);

  res.json({ message: 'Position supprimée' });
});

app.post('/api/transactions', auth, boardOnly, (req, res) => {
  const db = readDB();
  const payload = req.body || {};

  const transaction = {
    id: nextId(db.portfolio.transactions),
    date: String(payload.date || new Date().toISOString().slice(0, 10)),
    asset: String(payload.asset || '').trim(),
    ticker: String(payload.ticker || payload.asset || '').trim().toUpperCase(),
    type: String(payload.type || 'Achat').trim(),
    quantity:
      payload.quantity === null || payload.quantity === ''
        ? null
        : Number(payload.quantity || 0),
    amount: Number(payload.amount || 0),
    fees: Number(payload.fees || 0),
    currency: String(payload.currency || 'EUR').trim().toUpperCase(),
    note: String(payload.note || '').trim()
  };

  if (!transaction.asset || !transaction.type || Number.isNaN(transaction.amount)) {
    return res.status(400).json({ message: 'Transaction invalide' });
  }

  db.portfolio.transactions.unshift(transaction);

  const cash = db.portfolio.cash || { eur: 0, usd: 0, deposits: 0 };

  if (transaction.type === 'Dépôt') {
    cash.eur = round(Number(cash.eur || 0) + Number(transaction.amount || 0));
    cash.deposits = round(Number(cash.deposits || 0) + Number(transaction.amount || 0));
  }

  if (transaction.type === 'Achat') {
    cash.eur = round(Number(cash.eur || 0) - Number(transaction.amount || 0) - Number(transaction.fees || 0));
  }

  if (transaction.type === 'Vente') {
    cash.eur = round(Number(cash.eur || 0) + Number(transaction.amount || 0) - Number(transaction.fees || 0));
  }

  if (transaction.type === 'Frais') {
    cash.eur = round(Number(cash.eur || 0) - Number(transaction.amount || 0));
  }

  db.portfolio.cash = cash;
  writeDB(db);

  res.json({
    message: 'Transaction ajoutée',
    transaction
  });
});

app.post('/api/documents', auth, boardOnly, upload.single('file'), (req, res) => {
  const db = readDB();
  const payload = req.body || {};

  if (!payload.title || !String(payload.title).trim()) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(400).json({ message: 'Titre du document manquant' });
  }

  const document = {
    id: nextId(db.portfolio.documents),
    category: String(payload.category || 'Document').trim(),
    title: String(payload.title || '').trim(),
    description: String(payload.description || '').trim(),
    uploadedBy: req.user.username,
    uploadedAt: new Date().toISOString().slice(0, 10)
  };

  if (req.file) {
    document.fileName = req.file.originalname;
    document.storedName = req.file.filename;
    document.mimeType = req.file.mimetype;
    document.size = req.file.size;
  } else {
    document.content = String(payload.content || '').trim();
  }

  db.portfolio.documents.unshift(document);
  writeDB(db);

  res.json({
    message: 'Document ajouté',
    document: formatDocForClient(document)
  });
});

app.delete('/api/documents/:id', auth, boardOnly, (req, res) => {
  const db = readDB();
  const id = Number(req.params.id);
  const doc = db.portfolio.documents.find((item) => Number(item.id) === id);

  if (!doc) {
    return res.status(404).json({ message: 'Document introuvable' });
  }

  if (doc.storedName) {
    const filePath = path.join(UPLOADS_DIR, path.basename(doc.storedName));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  db.portfolio.documents = db.portfolio.documents.filter((item) => Number(item.id) !== id);
  writeDB(db);

  res.json({ message: 'Document supprimé' });
});

app.get('/documents/:id/file', auth, (req, res) => {
  const db = readDB();
  const id = Number(req.params.id);
  const doc = db.portfolio.documents.find((item) => Number(item.id) === id);

  if (!doc) {
    return res.status(404).json({ message: 'Document introuvable' });
  }

  if (!doc.storedName) {
    return res.status(400).json({ message: 'Ce document est une note interne, pas un fichier téléchargeable.' });
  }

  const filePath = path.join(UPLOADS_DIR, path.basename(doc.storedName));

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: 'Fichier introuvable' });
  }

  const downloadName = doc.fileName || path.basename(filePath);
  return res.download(filePath, downloadName);
});

app.get('/documents/:id/view', auth, (req, res) => {
  const db = readDB();
  const id = Number(req.params.id);
  const doc = db.portfolio.documents.find((item) => Number(item.id) === id);

  if (!doc) {
    return res.status(404).send('Document introuvable');
  }

  if (doc.storedName) {
    return res.redirect(`/documents/${doc.id}/file`);
  }

  const safeTitle = sanitizeText(doc.title || 'Document');
  const safeCategory = sanitizeText(doc.category || 'Document');
  const safeDescription = sanitizeText(doc.description || '');
  const safeContent = sanitizeText(doc.content || 'Aucun contenu détaillé renseigné.').replace(/\n/g, '<br>');

  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${safeTitle}</title>
        <style>
          body{
            font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
            background:#f5f0e9;
            color:#171411;
            padding:28px;
            margin:0
          }
          .wrap{
            max-width:900px;
            margin:0 auto;
            background:rgba(255,255,255,.82);
            border:1px solid rgba(23,20,17,.10);
            border-radius:28px;
            padding:32px;
            box-shadow:0 24px 70px rgba(24,22,20,.08)
          }
          small{
            display:block;
            color:#8c6a43;
            text-transform:uppercase;
            letter-spacing:.10em;
            margin-bottom:10px;
            font-weight:700
          }
          h1{
            font-family:Georgia,"Times New Roman",serif;
            font-size:2.2rem;
            margin:0 0 10px
          }
          p.meta{
            color:#6d655d;
            margin:0 0 24px;
            line-height:1.7
          }
          .content{
            line-height:1.9;
            color:#2b2722
          }
          a.back{
            display:inline-flex;
            align-items:center;
            justify-content:center;
            height:42px;
            padding:0 16px;
            border-radius:14px;
            background:linear-gradient(135deg,#181614,#2b2722);
            color:#f8f3ec;
            text-decoration:none;
            font-weight:600;
            margin-bottom:24px
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <a class="back" href="/dashboard.html">Retour au club</a>
          <small>${safeCategory}</small>
          <h1>${safeTitle}</h1>
          <p class="meta">${safeDescription}</p>
          <div class="content">${safeContent}</div>
        </div>
      </body>
    </html>
  `);
});

app.get('/api/test-quote', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'TSLA';
    const result = await tryYahooQuote(symbol);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});