const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// In-memory storage for bots
let bots = [];
let nextId = 1;

// Bot processes
const botProcesses = new Map();

// API Routes
app.get('/api/bots', (req, res) => {
    res.json(bots);
});

app.get('/api/bots/:id', (req, res) => {
    const bot = bots.find(b => b.id == req.params.id);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    res.json(bot);
});

app.post('/api/bots', (req, res) => {
    const { name, token, zip_file_url, presence, logs } = req.body;

    // Validate required fields
    if (!name || !token) {
        return res.status(400).json({ error: 'Nome e token são obrigatórios' });
    }

    // Check if bot name already exists
    if (bots.some(b => b.name.toLowerCase() === name.toLowerCase())) {
        return res.status(400).json({ error: 'Já existe um bot com este nome' });
    }

    const bot = {
        id: nextId++,
        name,
        token,
        status: 'stopped',
        zip_file_url,
        logs: logs || '',
        created_date: new Date().toISOString(),
        uptime_seconds: 0,
        presence: presence || { status: 'online', activities: [{ type: 3, name: 'Magnata Host 🌟' }] }
    };

    bots.push(bot);
    console.log(`Bot criado: ${bot.name} (ID: ${bot.id})`);
    res.json(bot);
});

app.put('/api/bots/:id', (req, res) => {
    const bot = bots.find(b => b.id == req.params.id);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }

    Object.assign(bot, req.body);
    res.json(bot);
});

app.delete('/api/bots/:id', (req, res) => {
    const index = bots.findIndex(b => b.id == req.params.id);
    if (index === -1) {
        return res.status(404).json({ error: 'Bot não encontrado' });
    }

    const bot = bots[index];

    // Stop bot process if running
    if (botProcesses.has(bot.id)) {
        botProcesses.get(bot.id).kill();
        botProcesses.delete(bot.id);
    }

    // Remove bot directory
    const botDir = path.join(__dirname, 'bots', `bot_${bot.id}`);
    if (fs.existsSync(botDir)) {
        fs.rmSync(botDir, { recursive: true, force: true });
    }

    bots.splice(index, 1);
    console.log(`Bot ${bot.name} deleted`);
    res.json({ success: true, message: 'Bot excluído com sucesso' });
});

app.post('/api/bots/:id/start', (req, res) => {
    const bot = bots.find(b => b.id == req.params.id);
    if (!bot) {
        return res.status(404).json({ error: 'Bot não encontrado' });
    }

    if (bot.status === 'running') {
        return res.json({ success: true, message: 'Bot já está rodando' });
    }

    if (bot.status === 'starting') {
        return res.json({ success: true, message: 'Bot já está iniciando' });
    }

    // Change status to starting
    bot.status = 'starting';
    bot.last_started = new Date().toISOString();

    // Create a simple Python bot script
    const botScript = `
# -*- coding: utf-8 -*-
import discord
from discord.ext import commands
import asyncio
import sys

TOKEN = "${bot.token}"

intents = discord.Intents.default()
bot = commands.Bot(command_prefix='!', intents=intents)

@bot.event
async def on_ready():
    print('Bot esta online!')
    print('Servidores:', len(bot.guilds))
    print('Usuarios:', len(bot.users))

@bot.command()
async def ping(ctx):
    await ctx.send('Pong! Bot esta funcionando!')

async def main():
    try:
        print('Iniciando bot...')
        await bot.start(TOKEN)
    except discord.LoginFailure:
        print('Token invalido!')
        sys.exit(1)
    except Exception as e:
        print('Erro ao iniciar bot:', str(e))
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
`;

    // Write bot script to file
    const botDir = path.join(__dirname, 'bots', `bot_${bot.id}`);
    if (!fs.existsSync(botDir)) {
        fs.mkdirSync(botDir, { recursive: true });
    }

    const scriptPath = path.join(botDir, 'main.py');
    fs.writeFileSync(scriptPath, botScript);

    // Start bot process
    const pythonProcess = spawn('python', [scriptPath], {
        cwd: botDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    botProcesses.set(bot.id, pythonProcess);

    // Handle process output
    let logs = bot.logs || '';

    pythonProcess.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
            const timestamp = new Date().toLocaleString();
            logs += `[${timestamp}] ${output}\n`;
            bot.logs = logs;
            console.log(`Bot ${bot.id} stdout:`, output);

            // Check if bot is ready
            if (output.includes('esta online!') && bot.status === 'starting') {
                bot.status = 'running';
                bot.uptime_seconds = 0;
                logs += `[${new Date().toLocaleString()}] Bot iniciado com sucesso!\n`;
                bot.logs = logs;
                console.log(`Bot ${bot.name} started successfully`);
            }
        }
    });

    pythonProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
            const timestamp = new Date().toLocaleString();
            logs += `[${timestamp}] ERROR: ${output}\n`;
            bot.logs = logs;
            console.error(`Bot ${bot.id} stderr:`, output);

            // If there's an error, stop the bot
            if (bot.status === 'starting') {
                bot.status = 'stopped';
                bot.uptime_seconds = 0;
                logs += `[${new Date().toLocaleString()}] Bot parado devido a erro\n`;
                bot.logs = logs;
            }
        }
    });

    pythonProcess.on('close', (code) => {
        bot.status = 'stopped';
        bot.uptime_seconds = 0;
        const exitReason = code === 0 ? 'normalmente' : `com erro (codigo: ${code})`;
        logs += `[${new Date().toLocaleString()}] Bot parado ${exitReason}\n`;
        bot.logs = logs;
        botProcesses.delete(bot.id);
        console.log(`Bot ${bot.id} stopped with code ${code}`);
    });

    // Timeout for bot startup
    setTimeout(() => {
        if (bot.status === 'starting') {
            bot.status = 'stopped';
            bot.uptime_seconds = 0;
            logs += `[${new Date().toLocaleString()}] Timeout: Bot nao iniciou\n`;
            bot.logs = logs;
            console.log(`Bot ${bot.name} startup timeout`);
        }
    }, 10000); // 10 second timeout

    res.json({ success: true, message: 'Bot está iniciando...' });
});

app.post('/api/bots/:id/stop', (req, res) => {
    const bot = bots.find(b => b.id == req.params.id);
    if (!bot) {
        return res.status(404).json({ error: 'Bot não encontrado' });
    }

    if (bot.status === 'stopped') {
        return res.json({ success: true, message: 'Bot já está parado' });
    }

    if (botProcesses.has(bot.id)) {
        botProcesses.get(bot.id).kill();
        botProcesses.delete(bot.id);
    }

    bot.status = 'stopped';
    bot.uptime_seconds = 0;
    bot.logs += `[${new Date().toLocaleString()}] 🛑 Bot parado manualmente\n`;
    console.log(`Bot ${bot.name} stopped manually`);

    res.json({ success: true, message: 'Bot parado com sucesso' });
});

app.post('/api/upload', (req, res) => {
    // Mock upload response
    res.json({
        file_url: 'uploaded_file.zip',
        success: true
    });
});

// Function to start bot automatically
async function startBotAutomatically(botId) {
    const bot = bots.find(b => b.id == botId);
    if (!bot || bot.status === 'running') return;

    console.log(`Iniciando bot ${bot.name} automaticamente...`);

    // Simulate starting bot
    bot.status = 'starting';
    bot.last_started = new Date().toISOString();

    // Create a simple Python bot script
    const botScript = `
import discord
from discord.ext import commands
import asyncio
import time

TOKEN = "${bot.token}"

intents = discord.Intents.default()
bot = commands.Bot(command_prefix='!', intents=intents)

@bot.event
async def on_ready():
    print(f'Bot {bot.user} está online!')
    # Set presence
    ${bot.presence ? `
    await bot.change_presence(
        status=discord.Status.${bot.presence.status || 'online'},
        activity=discord.Activity(
            type=discord.ActivityType.${bot.presence.activities && bot.presence.activities[0] ? bot.presence.activities[0].type === 3 ? 'watching' : 'playing' : 'playing'},
            name="${bot.presence.activities && bot.presence.activities[0] ? bot.presence.activities[0].name : 'Magnata Host 🌟'}"
        )
    )
    ` : ''}
    print('Presença configurada!')

@bot.command()
async def ping(ctx):
    await ctx.send('Pong! Bot está funcionando!')

# Keep bot running
async def main():
    try:
        await bot.start(TOKEN)
    except Exception as e:
        print(f'Erro ao iniciar bot: {e}')

if __name__ == "__main__":
    asyncio.run(main())
`;

    // Write bot script to file
    const botDir = path.join(__dirname, 'bots', `bot_${bot.id}`);
    if (!fs.existsSync(botDir)) {
        fs.mkdirSync(botDir, { recursive: true });
    }

    const scriptPath = path.join(botDir, 'main.py');
    fs.writeFileSync(scriptPath, botScript);

    // Start bot process
    const pythonProcess = spawn('python', [scriptPath], {
        cwd: botDir,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    botProcesses.set(bot.id, pythonProcess);

    // Handle process output
    let logs = bot.logs || '';
    const timestamp = new Date().toLocaleString();

    pythonProcess.stdout.on('data', (data) => {
        const output = data.toString();
        logs += `[${timestamp}] ${output}`;
        bot.logs = logs;
        console.log(`Bot ${bot.id} stdout:`, output);
    });

    pythonProcess.stderr.on('data', (data) => {
        const output = data.toString();
        logs += `[${timestamp}] ERROR: ${output}`;
        bot.logs = logs;
        console.log(`Bot ${bot.id} stderr:`, output);
    });

    pythonProcess.on('close', (code) => {
        bot.status = 'stopped';
        bot.uptime_seconds = 0;
        logs += `[${new Date().toLocaleString()}] Bot parado (código: ${code})\n`;
        bot.logs = logs;
        botProcesses.delete(bot.id);
        console.log(`Bot ${bot.id} stopped with code ${code}`);
    });

    // Update status after a short delay
    setTimeout(() => {
        if (bot.status === 'starting') {
            bot.status = 'running';
            bot.uptime_seconds = 0;
            logs += `[${new Date().toLocaleString()}] Bot iniciado com sucesso!\n`;
            bot.logs = logs;
        }
    }, 2000);
}

// Update uptime for running bots
setInterval(() => {
    bots.forEach(bot => {
        if (bot.status === 'running') {
            bot.uptime_seconds = (bot.uptime_seconds || 0) + 1;
        }
    });
}, 1000);

// Function to stop all bots
function stopAllBots() {
    console.log('Parando todos os bots...');
    botProcesses.forEach((process, botId) => {
        process.kill();
        const bot = bots.find(b => b.id == botId);
        if (bot) {
            bot.status = 'stopped';
            bot.uptime_seconds = 0;
            bot.logs += `[${new Date().toLocaleString()}] Bot parado devido ao desligamento do servidor\n`;
        }
    });
    botProcesses.clear();
}

// Handle server shutdown
process.on('SIGINT', () => {
    console.log('Recebido SIGINT. Desligando servidor e bots...');
    stopAllBots();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Recebido SIGTERM. Desligando servidor e bots...');
    stopAllBots();
    process.exit(0);
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('API endpoints:');
    console.log('GET  /api/bots');
    console.log('POST /api/bots');
    console.log('GET  /api/bots/:id');
    console.log('PUT  /api/bots/:id');
    console.log('DELETE /api/bots/:id');
    console.log('POST /api/bots/:id/start');
    console.log('POST /api/bots/:id/stop');
    console.log('POST /api/upload');

    // Bot não será iniciado automaticamente - apenas quando solicitado via API
});