const { Bot, InlineKeyboard } = require('grammy');
const solanaWeb3 = require('@solana/web3.js');
const { getAccount } = require('@solana/spl-token');
const axios = require('axios');
const fs = require('fs').promises;

// Initialize Telegram bot
const bot = new Bot('7083800815:AAGLc5T_hjpNf6Ts43nTkGTyfbDAqjZihXM');

// Solana connection
const endpoint = 'https://api.mainnet-beta.solana.com'; // Replace with QuickNode/Helius
const solanaConnection = new solanaWeb3.Connection(endpoint, 'confirmed');

// Database file
const DB_FILE = 'database.json';

// Load database
async function loadDatabase() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return { wallets: [], transactions: [], holdings: [] };
  }
}

// Save database
async function saveDatabase(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// Initialize database


// Command: /start
bot.command('start', (ctx) => {
  ctx.reply('Welcome to the Solana Tracker Bot! Use /track {address} [label] to start.');
});

// Command: /track {sol_address} [label]
bot.command('track', async (ctx) => {
  const db = await loadDatabase();
  const args = ctx.match.split(' ');
  const address = args[0];
  const label = args.slice(1).join(' ') || address;

  try {
    const pubKey = new solanaWeb3.PublicKey(address);
    db.wallets.push({ address, label, chatId: ctx.chat.id });
    await saveDatabase(db);
    ctx.reply(`Tracking wallet: ${address} (${label})`);
    monitorWallet(address, ctx.chat.id);
  } catch (error) {
    ctx.reply('Invalid Solana address!');
  }
});

// Command: /tracklist
bot.command('tracklist', async (ctx) => {
  const db = await loadDatabase();
  const wallets = db.wallets
    .filter((w) => w.chatId === ctx.chat.id)
    .map((w) => `${w.address} (${w.label})`)
    .join('\n');
  ctx.reply(wallets || 'No wallets tracked.');
});

// Command: /untrack {sol_address}
bot.command('untrack', async (ctx) => {
  const db = await loadDatabase();
  const address = ctx.match;
  db.wallets = db.wallets.filter((w) => w.address !== address || w.chatId !== ctx.chat.id);
  await saveDatabase(db);
  ctx.reply(`Stopped tracking wallet: ${address}`);
});

// Command: /stats {sol_address}
bot.command('stats', async (ctx) => {
  const db = await loadDatabase();
  const address = ctx.match;
  const transactions = db.transactions.filter((t) => t.address === address);
  const holdings = db.holdings.filter((h) => h.address === address);
  const summary = `
    Wallet: ${address}
    Total Transactions: ${transactions.length}
    Holdings:
    ${holdings.map((h) => `- ${h.amount} ${h.token}`).join('\n')}
  `;
  ctx.reply(summary);
});

// Monitor wallet for transactions
async function monitorWallet(address, chatId) {
  const db = await loadDatabase();
  const pubKey = new solanaWeb3.PublicKey(address);
  solanaConnection.onAccountChange(pubKey, async (accountInfo) => {
    const signatures = await solanaConnection.getSignaturesForAddress(pubKey, { limit: 1 });
    const tx = signatures[0];
    const txDetails = await solanaConnection.getTransaction(tx.signature, { commitment: 'confirmed' });

    const { meta, transaction } = txDetails;
    const type = detectTransactionType(txDetails); // Custom logic
    const details = await parseTransactionDetails(txDetails, type);
    const timestamp = new Date(tx.blockTime * 1000);

    // Save transaction
    db.transactions.push({ address, signature: tx.signature, type, details, timestamp });
    await saveDatabase(db);

    // Update holdings
    updateHoldings(address, details);

    // Send notification
    const keyboard = new InlineKeyboard()
      .url('View on Solscan', `https://solscan.io/tx/${tx.signature}`)
      .url('Chart', details.chartLink || 'https://dexscreener.com');
    ctx.api.sendMessage(chatId, formatNotification(address, type, details, timestamp), {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  });
}

// Detect transaction type
function detectTransactionType(tx) {
  const { instructions } = tx.transaction.message;
  if (instructions.some((i) => i.programId.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')) {
    return 'TokenTransfer'; // Simplified; extend for buy/sell/swap
  }
  // Add logic for swap (Raydium/Jupiter), bridge (Wormhole), etc.
  return 'Unknown';
}

// Parse transaction details
async function parseTransactionDetails(tx, type) {
  const db = await loadDatabase();
  const details = { amount: 0, token: 'SOL', chartLink: null, marketCap: null, coinAddress: null };
  if (type === 'TokenTransfer') {
    const tokenProgram = tx.transaction.message.instructions.find(
      (i) => i.programId.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
    );
    if (tokenProgram) {
      details.amount = tokenProgram.parsed.info.amount / 1e9; // Adjust decimals
      details.coinAddress = tokenProgram.parsed.info.mint;
      details.token = await getTokenSymbol(details.coinAddress);
      details.marketCap = await getMarketCap(details.token);
      details.chartLink = `https://dexscreener.com/solana/${details.coinAddress}`;
    }
  }
  // Add logic for swaps, bridges, etc.
  return details;
}

// Fetch token symbol (placeholder; use Helius/Birdeye API for accuracy)
async function getTokenSymbol(mint) {
  return 'TOKEN_X'; // Replace with API call
}

// Fetch market cap
async function getMarketCap(token) {
  try {
    const response = await axios.get(`https://api.coingecko.com/api/v3/coins/${token.toLowerCase()}`);
    return response.data.market_data.market_cap.usd;
  } catch (error) {
    return null;
  }
}

// Update holdings
async function updateHoldings(address, details) {
  const db = await loadDatabase();
  const holding = db.holdings.find((h) => h.address === address && h.token === details.token);
  if (holding) {
    holding.amount += details.amount;
  } else {
    db.holdings.push({ address, token: details.token, amount: details.amount });
  }
  await saveDatabase(db);
}

// Format notification
function formatNotification(address, type, details, timestamp) {
  return `
*Wallet*: ${address}
*Type*: ${type}
*Amount*: ${details.amount} ${details.token}
*Coin Address*: ${details.coinAddress || 'N/A'}
*Market Cap*: ${details.marketCap ? `$${details.marketCap}` : 'N/A'}
*Time*: ${timestamp}
*Signature*: ${tx.signature}
  `;
}

// Start bot
bot.start();
