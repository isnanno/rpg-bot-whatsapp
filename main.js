const fs = require('fs').promises; 
const { existsSync, readFileSync: readFileSyncSync } = require('fs'); 
const path = require('path');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    areJidsSameUser,
    jidNormalizedUser 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino'); 


console.log('[DEBUG] Script main.js (Baileys v4.0) iniciado.');


const PREFIX = '.';

const BOT_OWNER_JID = '5528981124442@s.whatsapp.net'; 

const DADOS_DIR = './dados';
const MIDIAS_DIR = './midias';
const AUTH_DIR = './auth_info_baileys'; 


const USUARIOS_DB = path.join(DADOS_DIR, 'usuarios.json');
const LOJA_DB = path.join(DADOS_DIR, 'loja.json');
const HABILIDADES_DB = path.join(DADOS_DIR, 'habilidades.json');
const CLAS_DB = path.join(DADOS_DIR, 'clas.json');


const PAYOUTS_DB = path.join(DADOS_DIR, 'payouts.json'); 
const TIMERS_DB = path.join(DADOS_DIR, 'timers.json');   
const SETTINGS_DB = path.join(DADOS_DIR, 'settings.json'); 


const PAYOUT_INTERVAL_MS = 15 * 60 * 1000; 
const RENDA_LOOP_INTERVAL = 15000; 
const SKILL_LOOP_INTERVAL = 1000;  
const CLAN_LOOP_INTERVAL = 60000;  
const CUSTO_GIRAR_CLA = 1500;


let retryCount = 0;
const MAX_RETRIES = 5; 
console.log('[DEBUG] Configurações v4.0 definidas.');


let usuarios = {};
let lojas = {};
let habilidades = {};
let clas = [];
let payouts = {};   
let timers = {};    
let settings = { dailyDiscount: { id: null, expires: 0 } }; 
let sock;
let knownGroups = new Set(); 
console.log('[DEBUG] Variáveis DB globais inicializadas.');


function normalizeJid(jid) {
    if (!jid) return null;
    if (jid.endsWith('@s.whatsapp.net')) {
        return jid.replace('@s.whatsapp.net', '@c.us');
    }
    return jid;
}
function denormalizeJid(jid) {
    if (!jid) return null;
    if (jid.endsWith('@c.us')) {
        return jid.replace('@c.us', '@s.whatsapp.net');
    }
    return jid;
}
console.log('[DEBUG] Funções JID (normalize/denormalize) definidas.');


let rateLimitQueue = [];
let isRateLimited = false;
let rateLimitEndTime = 0;

async function safeSendMessage(sock, jid, content, options = {}) {
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (isRateLimited) {
                const waitTime = rateLimitEndTime - Date.now();
                if (waitTime > 0) {
                    console.warn(`[RATE-LIMIT] Aguardando ${Math.ceil(waitTime / 1000)}s antes de enviar mensagem...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
                isRateLimited = false;
            }

            return await sock.sendMessage(jid, content, options);
        } catch (error) {
            lastError = error;
            const errorData = error?.data || error?.output?.statusCode;

            if (errorData === 429 || error?.message?.includes('rate-overlimit')) {
                const backoffTime = Math.min(30000 * Math.pow(2, attempt), 120000);
                console.error(`[RATE-LIMIT] WhatsApp rate limit atingido! Aguardando ${backoffTime / 1000}s... (Tentativa ${attempt + 1}/${maxRetries})`);

                isRateLimited = true;
                rateLimitEndTime = Date.now() + backoffTime;

                await new Promise(resolve => setTimeout(resolve, backoffTime));
                continue;
            } else if (error?.message?.includes('Connection Closed') || error?.message?.includes('Stream Errored')) {
                console.error(`[SEND-ERROR] Conexão perdida ao enviar mensagem. Descartando...`);
                return null;
            } else {
                console.error(`[SEND-ERROR] Erro ao enviar mensagem (tentativa ${attempt + 1}/${maxRetries}):`, error?.message || error);
                if (attempt < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
                }
            }
        }
    }

    console.error('[SEND-ERROR] Falha ao enviar mensagem após todas as tentativas. Descartando mensagem.');
    return null;
}

async function safeGroupMetadata(sock, jid) {
    try {
        return await sock.groupMetadata(jid);
    } catch (error) {
        const errorData = error?.data || error?.output?.statusCode;
        if (errorData === 429 || error?.message?.includes('rate-overlimit')) {
            console.warn(`[RATE-LIMIT] Rate limit ao buscar metadata do grupo. Retornando null.`);
        } else {
            console.error(`[METADATA-ERROR] Erro ao buscar metadata do grupo:`, error?.message || error);
        }
        return null;
    }
}

process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED-REJECTION] Erro não tratado capturado:', reason);
    if (reason?.message?.includes('rate-overlimit') || reason?.data === 429) {
        console.error('[UNHANDLED-REJECTION] Rate limit detectado. O bot continuará funcionando...');
        isRateLimited = true;
        rateLimitEndTime = Date.now() + 60000;
    }
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT-EXCEPTION] Exceção não tratada:', error);
    if (error?.message?.includes('rate-overlimit') || error?.data === 429) {
        console.error('[UNCAUGHT-EXCEPTION] Rate limit detectado. O bot continuará funcionando...');
        isRateLimited = true;
        rateLimitEndTime = Date.now() + 60000;
    } else {
        console.error('[UNCAUGHT-EXCEPTION] Erro crítico. Reiniciando em 5s...');
        setTimeout(() => {
            console.log('[RESTART] Tentando reconectar...');
            connectToWhatsApp().catch(err => console.error('[RESTART-ERROR]', err));
        }, 5000);
    }
});

console.log('[DEBUG] Sistema de proteção contra rate-limit inicializado.');


async function loadDB(filePath) {

    const isHabilidades = filePath.endsWith('habilidades.json');
    try {
        if (existsSync(filePath)) { 
            const data = await fs.readFile(filePath, 'utf8'); 
            try {
                const jsonData = JSON.parse(data);
                if (isHabilidades && typeof jsonData !== 'object') {
                    console.error(`!!!!!!!!! ERRO: ${filePath} NÃO é objeto JSON !!!`);
                    return {};
                }
                if (filePath === CLAS_DB && !Array.isArray(jsonData)) {
                    console.error(`!!!!!!!!! ERRO: ${filePath} NÃO é array JSON !!!`);
                    return [];
                }
                return jsonData;
            } catch (parseError) {
                console.error(`!!!!!!!!! ERRO DE PARSE EM ${filePath} !!!!!!!!!`);
                console.error(`Mensagem: ${parseError.message}`);

                const syncData = readFileSyncSync(filePath, 'utf8');
                const match = parseError.message.match(/position (\d+)/);
                if (match && syncData) {
                    const position = parseInt(match[1]),
                        lines = syncData.substring(0, position).split('\n'),
                        lineNum = lines.length,
                        colNum = lines[lines.length - 1].length + 1;
                    console.error(`Local Provável: Linha ${lineNum}, Coluna ${colNum}`);
                    const contextStart = Math.max(0, position - 50),
                        contextEnd = Math.min(syncData.length, position + 50);
                    console.error(`Contexto: ...${syncData.substring(contextStart, contextEnd)}...`);
                }
                console.error(`!!!!!!!!! FIM ERRO DE PARSE !!!!!!!!!`);
                if (filePath === CLAS_DB) return [];

                if ([PAYOUTS_DB, TIMERS_DB, SETTINGS_DB].includes(filePath)) return {}; 
                return {};
            }
        }
        if (isHabilidades) console.warn(`[loadDB] Arquivo ${filePath} não encontrado.`);
        if (filePath === CLAS_DB) {
            console.warn(`[loadDB] Arquivo ${filePath} não encontrado, retornando array vazio.`);
            return [];
        }

        if ([PAYOUTS_DB, TIMERS_DB, SETTINGS_DB].includes(filePath)) return {};
        return {};
    } catch (readError) {
        console.error(`Erro GERAL ao carregar ${filePath}:`, readError.message);
        if (filePath === CLAS_DB) return [];
        if ([PAYOUTS_DB, TIMERS_DB, SETTINGS_DB].includes(filePath)) return {};
        return {};
    }
}
async function saveDB(filePath, data) {

    try {
        const dir = path.dirname(filePath);
        if (!existsSync(dir)) {
            await fs.mkdir(dir, { recursive: true });
        }
        await fs.writeFile(filePath, JSON.stringify(data, null, 2)); 
    } catch (err) {
        console.error(`Erro ao salvar ${filePath}:`, err);
    }
}
console.log('[DEBUG] Funções loadDB e saveDB definidas (async).');


async function connectToWhatsApp() {
    console.log(`[DEBUG] Conectando ao WhatsApp... (Tentativa ${retryCount + 1}/${MAX_RETRIES + 1})`);
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'warn' });

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: true,
        logger,
        browser: ['Gemini-Bot-v4 (Baileys)', 'Chrome', '4.0.0'],
    });


    sock.ev.on('creds.update', saveCreds);


    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("[DEBUG] Evento 'qr'. Escaneie:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('[DEBUG] Evento "open" (Ready).');
            console.log('Bot de RPG v4.0 online!');
            retryCount = 0; 

            try {
                if (!existsSync(DADOS_DIR)) await fs.mkdir(DADOS_DIR, { recursive: true });
                if (!existsSync(MIDIAS_DIR)) await fs.mkdir(MIDIAS_DIR, { recursive: true });
            } catch (e) { console.error("Erro ao criar pastas:", e); }


            usuarios = await loadDB(USUARIOS_DB);
            loja = await loadDB(LOJA_DB);
            habilidades = await loadDB(HABILIDADES_DB);
            clas = await loadDB(CLAS_DB);


            payouts = await loadDB(PAYOUTS_DB);
            timers = await loadDB(TIMERS_DB);
            settings = await loadDB(SETTINGS_DB);


            if (!settings || typeof settings !== 'object') settings = {};
            if (!settings.dailyDiscount) settings.dailyDiscount = { id: null, expires: 0 };
            if (!settings.userToggles) settings.userToggles = {}; 

            if (!loja.categorias) console.warn('AVISO: loja.json vazio/inválido.');
            if (typeof habilidades !== 'object' || !habilidades || Object.keys(habilidades).length === 0)
                console.warn('AVISO: habilidades.json vazio/não carregado.');
            if (!Array.isArray(clas) || clas.length === 0)
                console.warn('AVISO: clas.json vazio/inválido.');


            await checkDailyDiscount(true); 


            console.log('\n========== VERIFICAÇÃO DE MÍDIAS ==========');
            const missingMedias = [];


            if (typeof habilidades === 'object' && habilidades) {
                for (const habId in habilidades) {
                    const hab = habilidades[habId];
                    if (hab.gif_id) {
                        const mp4Path = path.join(MIDIAS_DIR, hab.gif_id + '.mp4');
                        const gifPath = path.join(MIDIAS_DIR, hab.gif_id + '.gif');
                        if (!existsSync(mp4Path) && !existsSync(gifPath)) {
                            missingMedias.push(hab.gif_id + ' (habilidade: ' + habId + ')');
                        }
                    }
                }
            }


            if (loja.categorias) {
                for (const catId in loja.categorias) {
                    const cat = loja.categorias[catId];
                    if (cat.itens) {
                        for (const itemId in cat.itens) {
                            const item = cat.itens[itemId];
                            if (item.gif_id) {
                                const mp4Path = path.join(MIDIAS_DIR, item.gif_id + '.mp4');
                                const gifPath = path.join(MIDIAS_DIR, item.gif_id + '.gif');
                                if (!existsSync(mp4Path) && !existsSync(gifPath)) {
                                    missingMedias.push(item.gif_id + ' (loja: ' + catId + '/' + itemId + ')');
                                }
                            }
                        }
                    }
                }
            }

            if (missingMedias.length > 0) {
                console.log('⚠️  MÍDIAS FALTANTES:');
                missingMedias.forEach(m => console.log('   - ' + m));
                console.log('Total de mídias faltantes: ' + missingMedias.length);
            } else {
                console.log('✅ Todas as mídias foram encontradas!');
            }
            console.log('===========================================\n');


            console.log('Iniciando loop renda (Poll: ' + (RENDA_LOOP_INTERVAL/1000) + 's)...');
            setInterval(() => passiveIncomeLoop(sock), RENDA_LOOP_INTERVAL); 

            console.log('Iniciando loop skills (Poll: ' + (SKILL_LOOP_INTERVAL/1000) + 's)...');
            setInterval(() => skillTimerLoop(sock), SKILL_LOOP_INTERVAL); 

            console.log('Iniciando loop clãs (Poll: ' + (CLAN_LOOP_INTERVAL/1000) + 's)...');
            setInterval(() => clanCooldownLoop(sock), CLAN_LOOP_INTERVAL);

            console.log('Iniciando loop verificação de desconto diário (Poll: 1h)...');
            setInterval(() => checkDailyDiscountLoop(), 60 * 60 * 1000); 

        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.warn(`[RECONNECT] Conexão fechada: ${statusCode || lastDisconnect.error}. Reconectando: ${shouldReconnect}`);

            if (shouldReconnect) {
                if (retryCount < MAX_RETRIES) {

                    const delay = Math.pow(3, retryCount) * 5000; 
                    console.log(`[RECONNECT] Tentando reconectar em ${delay / 1000}s...`);
                    retryCount++;
                    setTimeout(connectToWhatsApp, delay);
                } else {
                    console.error(`[RECONNECT] Máximo de ${MAX_RETRIES} tentativas atingido. Desligando.`);
                }
            } else {
                console.log('[RECONNECT] Não é necessário reconectar (provavelmente logged out).');
            }
        }
    });
    console.log("[DEBUG] Listeners ('creds.update', 'connection.update') definidos.");


    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.message || message.key.fromMe) return;

        const chatId = message.key.remoteJid;
        if (!chatId || !chatId.endsWith('@g.us')) {

            return safeSendMessage(sock, chatId, { text: 'Só grupos.' });
        }

        if (chatId && chatId.endsWith('@g.us')) {
            knownGroups.add(chatId);
        }

        const rawAuthorId = message.key.participant || message.key.remoteJid;
        const authorId = normalizeJid(rawAuthorId); 

        if (!authorId) return; 


        const activeTimer = timers[chatId]; 
        const body = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();

        if (activeTimer) {
            const msgAnular = activeTimer.msg_anular?.toLowerCase();
            const bodyLower = body.toLowerCase();
            const getNum = (jid) => denormalizeJid(jid).split('@')[0];

            if (message.key.participant === denormalizeJid(activeTimer.targetId) && msgAnular && bodyLower === msgAnular) {

                const tNum = getNum(activeTimer.targetId);
                const aNum = getNum(activeTimer.attackerId);
                await safeSendMessage(sock, chatId, {
                    text: `⚔️ @${tNum} anulou @${aNum}!`,
                    mentions: [denormalizeJid(activeTimer.targetId), denormalizeJid(activeTimer.attackerId)],
                });
                delete timers[chatId];
                await saveDB(TIMERS_DB, timers); 
            } else if (activeTimer.affects_all_others && msgAnular && bodyLower === msgAnular) {

                const anNum = rawAuthorId.split('@')[0];
                const aNum = getNum(activeTimer.attackerId);
                let anulaMsg = "";

                if (activeTimer.skillId === 'belzebu') { anulaMsg = `☀️ @${anNum} usou sua fé! Hinata salvou o grupo e ninguém foi roubado!`; }
                else if (activeTimer.skillId === 'vazio_roxo') { anulaMsg = ` adaptou! @${anNum} invocou Mahoraga e anulou o Vazio Roxo!`; }
                else if (activeTimer.skillId === 'santuario_malevolente') { anulaMsg = `♾️ @${anNum} expandiu seu domínio! O Santuário de @${aNum} foi neutralizado!`; }
                else if (activeTimer.skillId === 'respiracao_do_sol') { anulaMsg = `🌙 @${anNum} usou a Respiração da Lua! A técnica de @${aNum} foi bloqueada!`; }
                else { anulaMsg = `🛡️ @${anNum} repeliu @${aNum}! Ataque em área anulado!`; }

                await safeSendMessage(sock, chatId, { text: anulaMsg, mentions: [rawAuthorId, denormalizeJid(activeTimer.attackerId)], });
                delete timers[chatId];
                await saveDB(TIMERS_DB, timers); 
            }
        }


        if (!body.startsWith(PREFIX)) return;
        const args = body.slice(PREFIX.length).trim().split(/ +/),
            command = args.shift().toLowerCase();

        if (command !== 'cadastro' && !usuarios[authorId]) {
            return safeSendMessage(sock, chatId, { text: `Não cadastrado! Use *.cadastro NOME*` });
        }


        if (command !== 'cadastro' && usuarios[authorId]) {
            usuarios[authorId].lastKnownChatId = chatId;
        }

        try {

            if (command.startsWith('loja_')) {
                await handleLojaCategoria(message, command.substring(5), chatId);
                return;
            }
            if (command.startsWith('habilidades_')) {
                await handleHabilidadesCategoria(message, command.substring(12), chatId);
                return;
            }

            switch (command) {
                case 'cadastro': await handleCadastro(message, args, authorId, chatId); break;
                case 'menu': await handleMenu(message, authorId, chatId); break;

                case 'loja':

                const lojaId = (args[0] || '').toLowerCase();
                if (!lojaId) {

                    await handleLoja(message, chatId);
                    break;
                }


                const resolvedLojaId = SIGLA_MAP_LOJA[lojaId] || lojaId;


                if (loja.categorias && loja.categorias[resolvedLojaId]) {
                    await handleLojaCategoria(message, resolvedLojaId, chatId);
                } else {
                    return safeSendMessage(sock, chatId, { text: `Loja *${lojaId}* não encontrada.` });
                }
                break;
                case 'comprar': await handleComprar(message, args, authorId, chatId); break;

                case 'habilidades':

                const habArg = (args[0] || '').toLowerCase();
                if (!habArg) {

                    await handleHabilidades(message, chatId);
                    break;
                }


                const resolvedAnimeName = SIGLA_MAP_HABILIDADES[habArg];

                if (resolvedAnimeName) {


                    await handleHabilidadesCategoria(message, resolvedAnimeName.replace(/ /g, '_'), chatId);
                } else {


                    let hasSkills = false;
                    if (typeof habilidades === 'object' && habilidades) {
                        for (const hId in habilidades) {
                            const h = habilidades[hId];
                            if (h.preco === 0) continue;
                            const animeName = (h.anime || '').toLowerCase();
                            if (animeName.replace(/[^a-z0-9]/g, '_') === habArg || animeName === habArg) {
                                hasSkills = true;
                                break;
                            }
                        }
                    }

                    if (hasSkills) {

                        await handleHabilidadesCategoria(message, habArg, chatId);
                    } else {

                        const claDef = clas.find(c => c.id === habArg || c.sigla === habArg);
                        if (claDef) {
                            await handleHabilidadesCla(message, authorId, chatId, claDef);
                        } else {
                            return safeSendMessage(sock, chatId, { text: `Categoria/Clã *${habArg}* não encontrado.` });
                        }
                    }
                }
                break;

                case 'trade': await handleTrade(message, args, authorId, chatId); break;

                case 'banco': await handleBanco(message, authorId, chatId); break;
                case 'depositar': await handleDepositar(message, args, authorId, chatId); break;
                case 'sacar': await handleSacar(message, args, authorId, chatId); break;
                case 'pix': await handlePix(message, args, authorId, chatId); break;
                case 'carteira': await handleCarteira(message, authorId, chatId); break;

                case 'diario': await handleDiario(message, authorId, chatId); break;
                case 'trabalhar': await handleTrabalhar(message, authorId, chatId); break;
                case 'minerar': await handleMinerar(message, authorId, chatId); break;
                case 'pescar': await handlePescar(message, authorId, chatId); break;
                case 'crime': await handleCrime(message, authorId, chatId); break;
                case 'explorar': await handleExplorar(message, authorId, chatId); break;
                case 'caçar': await handleCaçar(message, authorId, chatId); break;
                case 'forjar': await handleForjar(message, authorId, chatId); break;
                case 'fazerbolo': await handleFazerBolo(message, authorId, chatId); break;
                case 'menugold': await handleMenuGold(message, authorId, chatId); break;

                case 'clas': await handleClas(message, authorId, chatId); break;
                case 'girarcla': await handleGirarCla(message, args, authorId, chatId); break;
                case 'listarclas': await handleListarClas(message, chatId); break;

                case 'configurar': await handleConfigurar(message, chatId); break;
                case 'nick': await handleNick(message, args, authorId, chatId); break;
                case 'set': await handleSetNotifGrupo(message, authorId, chatId); break;
                case 'renda': await handleToggleRenda(message, authorId, chatId); break; 

                case 'add': await handleAddMoney(message, args, authorId, chatId); break;
                case 'pocoes': await handlePocoes(message, args, authorId, chatId); break;
                case 'vender': await handleVenda(message, args, authorId, chatId); break;

                default:
                    if (typeof habilidades === 'object' && habilidades && habilidades[command]) {
                        const hab = habilidades[command];


                        if (hab.is_clan_skill) {

                            await handleUsarHabilidadeCla(message, command, authorId, chatId);
                        } else {

                            await handleUsarHabilidade(message, command, authorId, chatId);
                        }
                    }
            }
        } catch (err) {
            console.error(`Erro comando "${command}":`, err);
            await safeSendMessage(sock, chatId, { text: `Erro ".${command}". 😵` });
        }
    });
    console.log("[DEBUG] Listener 'messages.upsert' (v4.0) definido.");
}


console.log('[DEBUG] Chamando connectToWhatsApp()...');
connectToWhatsApp(); 
console.log('[DEBUG] connectToWhatsApp() chamado. Aguardando...');


const ANIME_SIGLAS = {
    'jujutsu kaisen': 'jjk',
    'one piece': 'op',
    'attack on titan': 'aot',
    'dragon ball': 'dbz',
    'demon slayer': 'ds',
    'blue lock': 'bl',
    'naruto': 'naruto', 
    'bleach': 'bleach',
    'death note': 'dn',
    'code geass': 'geass',
    'fate': 'fate',
    'jojo\'s bizarre adventure': 'jojo',
    'eminence in shadow': 'atomic',
    'tensei slime': 'slime',
    'madoka magica': 'madoka',
    'one punch man': 'opm',
    'my hero academia': 'mha'
};

const SIGLA_MAP_HABILIDADES = Object.fromEntries(
    Object.entries(ANIME_SIGLAS).map(([k, v]) => [v, k.toLowerCase().replace(/[^a-z0-9]/g, '_')])
);


const SIGLA_MAP_LOJA = {
    'jjk': 'jujutsu_kaisen',
    'op': 'one_piece',
    'aot': 'attack_on_titan',
    'dbz': 'dragon_ball',
    'ds': 'demon_slayer',
    'bl': 'blue_lock',
    'naruto': 'naruto'
};


function getDateInBrasilia() {
    const options = {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    };

    return new Date().toLocaleDateString('en-CA', options);
}

async function handleCadastro(message, args, authorId, chatId) {
    if (usuarios[authorId]) return safeSendMessage(sock, chatId, { text: 'Você já está cadastrado!' });
    const nome = args.join(' ');
    if (!nome) return safeSendMessage(sock, chatId, { text: 'Precisa me dizer seu nome! Use: *.cadastro SEU-NOME*' });

    const claSorteado = sortearCla(clas); 
    if (!claSorteado) return safeSendMessage(sock, chatId, { text: 'Erro no cadastro: Não foi possível sortear um clã (DB de clãs vazio?).' });

    let ouroInicial = 100, habilidadesIniciais = [];
    if (claSorteado.buff) {
        switch (claSorteado.buff.type) {
            case 'gold_start': ouroInicial += claSorteado.buff.amount || 0; break;
            case 'skill_start':
                if (typeof habilidades === 'object' && habilidades && claSorteado.buff.skillId && habilidades[claSorteado.buff.skillId]) {
                    habilidadesIniciais.push(claSorteado.buff.skillId);
                } else {
                    console.warn(`Skill inicial "${claSorteado.buff.skillId}" do clã "${claSorteado.id}" não encontrada.`);
                }
                break;
        }
    }

    usuarios[authorId] = { nome, ouro: ouroInicial, bank: 0, cla: claSorteado.nome, cla_id: claSorteado.id, passivos: [], habilidades: habilidadesIniciais, cooldowns: {}, job: null, lastKnownChatId: chatId };


    if (claSorteado.id === 'gojo') {
        usuarios[authorId].mugen_charges = 1; 
        usuarios[authorId].mugen_cooldown = Date.now(); 
    }
    if (claSorteado.id === 'meliodas') {
        usuarios[authorId].cooldowns = usuarios[authorId].cooldowns || {};
        usuarios[authorId].cooldowns.reacao_total = 0;
    }

    await saveDB(USUARIOS_DB, usuarios);

    const authorNumber = authorId.split('@')[0]; 
    const replyText = `🎉 Bem-vindo ao RPG, @${authorNumber}!\n\nNome: *${nome}*\nClã: *${claSorteado.nome}*\nBuff: ${claSorteado.buff?.description || 'Nenhum.'}\n\nComeça com *${fmt(ouroInicial)} Ouro*.\nUse *.menu* para comandos.`;

    await safeSendMessage(sock, chatId, {
        text: replyText,
        mentions: [denormalizeJid(authorId)], 
    });
}

async function handleMenu(message, authorId, chatId) {
    const user = usuarios[authorId];
    const authorNumber = authorId.split('@')[0];
    const top = '╭ೋ⚘ೋ•═══════════╗', mid = '⚘', sep = '════════ •『 ✨ 』• ════════', bot = '╚═══════════•ೋ⚘ೋ╯', icon = '🔹';

    let menuText = `${top}\n${mid} *Perfil de @${authorNumber}*\n${mid}\n${mid} *Nome:* ${user.nome}\n${mid} *Clã:* ${user.cla}\n`;


    if (user.cla_id === 'gojo') {
        const charges = user.mugen_charges || 0;
        if (charges > 0) {
            menuText += `${mid} *Mugen (Cargas):* ${charges} ♾️\n`;
        } else {
            const cd = user.mugen_cooldown || 0;
            const tLeft = timeLeft(cd); 
            menuText += `${mid} *Mugen (Cargas):* 0 ♾️\n${mid} *Recarregando:* ${tLeft}\n`;
        }
    }


    menuText += `${mid} *Ouro:* ${fmt(user.ouro || 0)}💰\n${mid} *Banco:* ${fmt(user.bank || 0)}🏦\n${mid} ${sep}\n${mid} *Comandos Principais*\n${mid}   ${icon} *.loja*\n${mid}   ${icon} *.habilidades*\n${mid}   ${icon} *.menugold*\n${mid}   ${icon} *.clas*\n`;

    menuText += `${mid}   ${icon} *.configurar*\n${mid}   ${icon} *.pocoes*\n${mid} ${sep}\n${mid} *Posses*\n${mid} *Renda (${user.passivos?.length || 0}):*\n`;


    if (!user.passivos?.length) menuText += `${mid}   ${icon} _Nenhum item._\n`;
    else {
        const now = Date.now();
        user.passivos.forEach(p => {
            const itemId = p.id || p;
            const userPayouts = payouts[authorId] || {};
            const nextPayment = userPayouts[itemId] || 0;
            let timeMsg = "";
            if (nextPayment > now) {
                const timeLeftMs = nextPayment - now;
                const minutesLeft = Math.ceil(timeLeftMs / 60000);
                timeMsg = ` (${minutesLeft}min)`;
            } else {
                timeMsg = ` (pronto!)`;
            }
            menuText += `${mid}   ${icon} ${p.nome || p.id}${timeMsg}\n`;
        });
    }

    menuText += `${mid}\n${mid} *Habilidades (${user.habilidades?.length || 0}):*\n`;
    if (!user.habilidades?.length) menuText += `${mid}   ${icon} _Nenhuma._\n`;
    else {
        user.habilidades.forEach(hId => {
            const d = (typeof habilidades === 'object' && habilidades) ? habilidades[hId] : null;
            if (d) {
                let u = `(.${hId})`;
                if (d.uso === 'Passivo (ativa automaticamente)') u = '(P)';
                else if (d.requires_no_target === false) u = `(.${hId} @alvo)`;


                let cdMsg = "";
                if (d.is_clan_skill) {
                    const cdKey = hId.startsWith('.') ? hId.substring(1) : hId;
                    const cd = user.cooldowns?.[cdKey] || user.cooldowns?.[hId] || 0;
                    const now = Date.now();
                    if (cd > now) {
                        cdMsg = ` (CD: ${timeLeft(cd)})`; 
                    } else if (d.cooldown_sec) {
                        cdMsg = ` (pronto)`;
                    }
                }

                menuText += `${mid}   ${icon} ${d.nome} ${u}${cdMsg}\n`;
            } else menuText += `${mid}   ${icon} ${hId}(??)\n`;
        });
    }
    menuText += `${bot}`;

    const videoPath = path.join(MIDIAS_DIR, 'menu.mp4');
    const gifPath = path.join(MIDIAS_DIR, 'menu.gif');
    const imgFallbackPath = path.join(MIDIAS_DIR, 'menu.jpg');

    try {
        let mediaBuffer = null, isVideo = false;
        if (existsSync(videoPath)) { mediaBuffer = await fs.readFile(videoPath); isVideo = true; }
        else if (existsSync(gifPath)) { mediaBuffer = await fs.readFile(gifPath); isVideo = true; }
        else if (existsSync(imgFallbackPath)) { mediaBuffer = await fs.readFile(imgFallbackPath); }

        if (mediaBuffer) {
            const options = { caption: menuText, mentions: [denormalizeJid(authorId)] };
            if (isVideo) { options.video = mediaBuffer; options.gifPlayback = true; options.mimetype = 'video/mp4'; }
            else { options.image = mediaBuffer; }
            await safeSendMessage(sock, chatId, options);
        } else {
            console.warn(`[handleMenu] Nenhuma mídia (mp4, gif, jpg) enc. Usando fallback URL.`);
            await safeSendMessage(sock, chatId, {
                image: { url: 'https://img.odcdn.com.br/wp-content/uploads/2022/07/anya.jpg' },
                caption: menuText,
                mentions: [denormalizeJid(authorId)],
            });
        }
    } catch (menuError) {
        console.error(`!!! Erro enviar menu ${authorId}: ${menuError.message}`);
        await safeSendMessage(sock, chatId, { text: `⚠️ Erro mídia menu.\n\n${menuText}`, mentions: [denormalizeJid(authorId)] });
    }
}

async function handleLoja(message, chatId) {
    const top = '╭ೋ🛒ೋ•═══════════╗', mid = '🛒', sep = '═══════ •『 Anime 』• ═══════', bot = '╚═══════════•ೋ🛒ೋ╯', icon = '🔹';
    let txt = `${top}\n${mid} *Loja Renda Passiva*\n${mid}\n`;
    if (!loja.categorias || Object.keys(loja.categorias).length === 0) {
        txt += `${mid} Loja vazia. 😥\n${bot}`;
        return safeSendMessage(sock, chatId, { text: txt });
    }
    txt += `${mid} Escolha uma categoria:\n${mid} ${sep}\n`;
    for (const cId in loja.categorias) {
        const cat = loja.categorias[cId];
        txt += `${mid} ${icon} *${cat.nome_categoria}*\n${mid}    Cmd: \`${PREFIX}loja_${cId}\``;

        if (cat.sigla) {
            txt += ` (ou \`${PREFIX}loja_${cat.sigla}\`)`;
        }
        txt += `\n`;
    }
    txt += `${bot}`;
    await safeSendMessage(sock, chatId, { text: txt });
}

async function handleLojaCategoria(message, catId, chatId) {

    let cat = loja.categorias?.[catId];
    if (!cat) {
        const resolvedId = SIGLA_MAP_LOJA[catId];
        if (resolvedId) cat = loja.categorias[resolvedId];
    }

    if (!cat) return safeSendMessage(sock, chatId, { text: `Categoria "${catId}" não enc. 😕` });

    const top = `╭ೋ🛒ೋ•═════ ${cat.nome_categoria} ═════╗`, mid = '🛒', bot = '╚══════════════•ೋ🛒ೋ╯', icon = '✨';

    let txt = `${top}\n${mid} Use \`${PREFIX}comprar <id>\`\n${mid}\n`;

    if (!cat.itens || Object.keys(cat.itens).length === 0) txt += `${mid} _Vazio._\n`;
    else {
        for (const itemId in cat.itens) {
            const i = cat.itens[itemId];
            txt += `${mid} ${icon} *${i.nome}*\n${mid}    ID: \`${itemId}\`\n${mid}    Preço: ${fmt(i.preco)}\n${mid}    Renda: ${fmt(i.renda)}/${i.cooldown_min}min\n${mid}    Info: ${i.descricao}\n${mid}\n`;
        }
    }
    txt += `${bot}`;
    await safeSendMessage(sock, chatId, { text: txt });
}


async function handleComprar(message, args, authorId, chatId) {
    const itemId = args[0]?.toLowerCase();
    if (!itemId) return safeSendMessage(sock, chatId, { text: `ID do item/habilidade? Ex: *.comprar itoshirin_gol* ou *.comprar deathnote*` }, { quoted: message });


    const { item: lojaItem, catId } = findItemInLoja(itemId, true); 


    const habId = Object.keys(habilidades).find(k => k.toLowerCase() === itemId);
    const habItem = habId ? habilidades[habId] : null;

    if (lojaItem) {

        await handleCompraLojaItem(message, args, authorId, chatId, lojaItem, catId, itemId);
    } else if (habItem && habItem.preco > 0) {

        await handleCompraHabilidade(message, args, authorId, chatId, habItem, habId);
    } else if (habItem && habItem.preco === 0) {

        return safeSendMessage(sock, chatId, { text: `🚫 A habilidade *${habItem.nome}* não pode ser comprada (é uma skill de clã ou bônus).` }, { quoted: message });
    } else {

        return safeSendMessage(sock, chatId, { text: `Item/Habilidade *${itemId}* não encontrado! 😕 Verifique na *.loja* ou *.habilidades*.` }, { quoted: message });
    }
}


async function handleCompraLojaItem(message, args, authorId, chatId, item, catId, originalItemId) {
    const user = usuarios[authorId];
    user.passivos = user.passivos || [];

    const jaPossui = user.passivos.some(p => p.id.toLowerCase() === originalItemId);
    if (jaPossui) {
        return safeSendMessage(sock, chatId, { text: `🚫 Você já possui o item *${item.nome}*! Não é permitido comprar itens de renda repetidos.` }, { quoted: message });
    }


    const { finalPrice, discountMsg } = getDynamicPrice(item, catId, user, 'loja'); 

    if ((user.ouro || 0) < finalPrice) {
        return safeSendMessage(sock, chatId, { text: `Ouro insuficiente! 😥\nPreço: ${fmt(finalPrice)}${discountMsg}\nSeu: ${fmt(user.ouro || 0)}` }, { quoted: message });
    }

    user.ouro -= finalPrice;

    const realItemId = Object.keys(loja.categorias[catId].itens).find(k => k.toLowerCase() === originalItemId) || originalItemId;


    const nextPayoutTime = Date.now() + item.cooldown_min * 60000;
    user.passivos.push({ id: realItemId, nome: item.nome }); 

    payouts[authorId] = payouts[authorId] || {}; 
    payouts[authorId][realItemId] = nextPayoutTime;

    await saveDB(USUARIOS_DB, usuarios);
    await saveDB(PAYOUTS_DB, payouts);

    await safeSendMessage(sock, chatId, { text: `💸 Comprou *${item.nome}* por ${fmt(finalPrice)} Ouro${discountMsg}.\nRende em ${item.cooldown_min} min.` }, { quoted: message });
}


async function handleCompraHabilidade(message, args, authorId, chatId, hab, originalHabId) {
    const user = usuarios[authorId];
    user.cooldowns = user.cooldowns || {};
    user.habilidades = user.habilidades || [];
    const n = Date.now();


    const { finalPrice, discountMsg } = getDynamicPrice(hab, originalHabId, user, 'habilidade'); 


    if (finalPrice > 49000) {
        const C = 24 * 60 * 60 * 1000; 
        const c = user.cooldowns.buy_expensive_skill || 0;
        if (n < c) {
            return safeSendMessage(sock, chatId, { text: `⏳ Você só pode comprar habilidades caras (+49k) novamente em ${timeLeft(c)}.` }, { quoted: message });
        }
        user.cooldowns.buy_expensive_skill = n + C; 
    }

    if ((user.ouro || 0) < finalPrice) {
        if (finalPrice > 49000) delete user.cooldowns.buy_expensive_skill; 
        return safeSendMessage(sock, chatId, { text: `Ouro insuficiente! 😥\nPreço: ${fmt(finalPrice)}${discountMsg}\nSeu: ${fmt(user.ouro || 0)}` }, { quoted: message });
    }


    if (user.habilidades.includes(originalHabId)) {
        if (finalPrice > 49000) delete user.cooldowns.buy_expensive_skill; 
         return safeSendMessage(sock, chatId, { text: `🚫 Você já possui a habilidade *${hab.nome}*!` }, { quoted: message });
    }

    user.ouro -= finalPrice;
    user.habilidades.push(originalHabId);
    await saveDB(USUARIOS_DB, usuarios);

    const comandoCorreto = hab.requires_no_target === true 
        ? `.${originalHabId}` 
        : hab.is_info_skill 
            ? `.${originalHabId} @usuario`
            : `.${originalHabId} @usuario`;
    await safeSendMessage(sock, chatId, { text: `🔥 Comprou *${hab.nome}* por ${fmt(finalPrice)} Ouro${discountMsg}.\nUse ${comandoCorreto}!` }, { quoted: message });
}

async function handleHabilidades(message, chatId) {
    const top = '╭ೋ💥ೋ•═══════════╗', mid = '💥', sep = '═══════ •『 Anime 』• ═══════', bot = '╚═══════════•ೋ💥ೋ╯', icon = '🔹';
    let txt = `${top}\n${mid} *Loja Habilidades (PvP)*\n${mid}\n`;

    if (typeof habilidades !== 'object' || !habilidades || Object.keys(habilidades).length === 0) {
        txt += `${mid} Habilidades vazias/não carregadas. 😥\n${bot}`;
        return safeSendMessage(sock, chatId, { text: txt });
    }

    const cats = {};
    let hasB = false;
    for (const hId in habilidades) {
        const h = habilidades[hId];
        if (h.preco === 0) continue; 
        hasB = true;
        const anime = h.anime || 'Outros';
        const aK = anime.toLowerCase().replace(/[^a-z0-9]/g, '_');
        if (!cats[aK]) cats[aK] = { nome_categoria: anime };
    }

    if (!hasB) {
        txt += `${mid} Nenhuma comprável. 😥\n${bot}`;
        return safeSendMessage(sock, chatId, { text: txt });
    }

    txt += `${mid} Escolha uma categoria:\n${mid} ${sep}\n`;
    for (const catId in cats) {
        txt += `${mid} ${icon} *${cats[catId].nome_categoria}*\n${mid}    Cmd: \`${PREFIX}habilidades_${catId}\``;

        const sigla = ANIME_SIGLAS[cats[catId].nome_categoria.toLowerCase()];
        if (sigla) {
            txt += ` (ou \`${PREFIX}habilidades_${sigla}\`)`;
        }
        txt += `\n`;
    }
    txt += `${bot}`;
    await safeSendMessage(sock, chatId, { text: txt });
}

async function handleHabilidadesCategoria(message, catId, chatId) {

    const authorId = normalizeJid(message.key.participant || message.key.remoteJid);
    if (!authorId) return; 
    const user = usuarios[authorId];


    let resolvedCatName = (SIGLA_MAP_HABILIDADES[catId] || catId);

    const resolvedCatNameNormalized = resolvedCatName.replace(/[^a-z0-9]/g, '_');

    let nomeCat = 'Desconhecida', habs = [];
    if (typeof habilidades === 'object' && habilidades) {
        for (const hId in habilidades) {
            const h = habilidades[hId];
            if (h.preco === 0) continue;
            const animeName = (h.anime || 'Outros').toLowerCase();
            const animeNameNormalized = animeName.replace(/[^a-z0-9]/g, '_');

            if (animeNameNormalized === resolvedCatNameNormalized) {
                nomeCat = h.anime || 'Outros';
                habs.push(hId);
            }
        }
    }

    if (habs.length === 0) return safeSendMessage(sock, chatId, { text: `Nenhuma comprável em "${catId}" ou erro. 😕` });

    const top = `╭ೋ💥ೋ•═════ Habilidades ${nomeCat} ═════╗`, mid = '💥', bot = '╚══════════════•ೋ💥ೋ╯', icon = '🔥';

    let txt = `${top}\n${mid} Use \`${PREFIX}comprar <id>\`\n${mid}\n`;


    if (settings.dailyDiscount?.id) {
        const d = settings.dailyDiscount;
        const h = habilidades[d.id];
        if (h) {
            txt += `🎁 *OFERTA DO DIA (50% OFF)*\n${mid} ID: \`${d.id}\` (${h.nome})\n${mid} Expira em: ${timeLeft(d.expires)}\n${mid}\n`;
        }
    }

    for (const hId of habs) {
        const h = habilidades[hId];

        const { finalPrice, discountMsg } = getDynamicPrice(h, hId, user, 'habilidade'); 

        txt += `${mid} ${icon} *${h.nome}*\n${mid}    ID: \`${hId}\`\n${mid}    Preço: ${fmt(finalPrice)}${discountMsg}\n${mid}    Uso: ${h.uso}\n${mid}    Info: ${h.descricao}\n${mid}\n`;
    }
    txt += `${bot}`;
    await safeSendMessage(sock, chatId, { text: txt });
}

async function handleTrade(message, args, authorId, chatId) {

    const user = usuarios[authorId];
    const habId = args[0]?.toLowerCase();

    if (!habId) {
        return safeSendMessage(sock, chatId, { text: `Qual habilidade? Use: *.trade <id_habilidade> @alvo*` }, { quoted: message });
    }

    let rawTargetJid = null;
    let tId = null;
    let targetNumber = null;

    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentionedJids.length === 0) {
        return safeSendMessage(sock, chatId, { text: `Marque o usuário para quem quer transferir! Use: *.trade ${habId} @alvo*` }, { quoted: message });
    }

    rawTargetJid = mentionedJids[0];
    tId = normalizeJid(rawTargetJid);
    targetNumber = rawTargetJid.split('@')[0];

    const targetUser = usuarios[tId];
    if (!targetUser) return safeSendMessage(sock, chatId, { text: 'Alvo não cadastrado.' }, { quoted: message });
    if (tId === authorId) return safeSendMessage(sock, chatId, { text: 'Não pode transferir para si mesmo!' }, { quoted: message });

    const habIndex = user.habilidades?.findIndex(h => h.toLowerCase() === habId);
    if (habIndex === -1 || habIndex === undefined) {
        return safeSendMessage(sock, chatId, { text: `Você não possui a habilidade *${habId}*!` }, { quoted: message });
    }

    const originalHabId = user.habilidades[habIndex];
    const habData = (typeof habilidades === 'object' && habilidades) ? habilidades[originalHabId] : null;

    if (!habData || habData.preco === 0) {
        return safeSendMessage(sock, chatId, { text: `A habilidade *${habData?.nome || habId}* é intransferível (provavelmente é uma skill de clã).` }, { quoted: message });
    }


    if (targetUser.habilidades?.includes(originalHabId)) {
        return safeSendMessage(sock, chatId, { text: `🚫 @${targetNumber} já possui a habilidade *${habData.nome}*!`, mentions: [denormalizeJid(tId)] }, { quoted: message });
    }

    const [tradedSkill] = user.habilidades.splice(habIndex, 1);
    targetUser.habilidades = targetUser.habilidades || [];
    targetUser.habilidades.push(tradedSkill);

    await saveDB(USUARIOS_DB, usuarios);

    const authorNumber = authorId.split('@')[0];
    const replyText = `⚡ @${authorNumber} confiou seu poder lendário (*${habData.nome}*) para @${targetNumber}! Que o destino os observe! ⚡`;

    await safeSendMessage(sock, chatId, {
        text: replyText,
        mentions: [denormalizeJid(authorId), denormalizeJid(tId)],
    });
}


async function handleClas(message, authorId, chatId) {
    const user = usuarios[authorId];
    const claData = clas.find(c => c.id === user.cla_id);
    if (!claData) return safeSendMessage(sock, chatId, { text: 'Erro: Não foi possível encontrar dados do seu clã.' });

    const { rarities, total } = getClaRarities(); 
    if (total === 0) return safeSendMessage(sock, chatId, { text: 'Erro: Clãs não configurados ou com chance 0.' });

    const percentage = rarities[user.cla_id] || 0;
    const authorNumber = authorId.split('@')[0];

    const top = '╭ೋ⛩️ೋ•═══════════╗', mid = '⛩️', bot = '╚═══════════•ೋ⛩️ೋ╯';
    let txt = `${top}\n${mid} *Clã de @${authorNumber}*\n${mid}\n`;
    txt += `${mid} *Nome:* ${claData.nome}\n`;
    txt += `${mid} *Buff:* ${claData.buff?.description || 'Nenhum.'}\n`;
    txt += `${mid} *Raridade:* ${percentage.toFixed(2)}%\n`;


    if (user.cla_id === 'gojo') {
        const charges = user.mugen_charges || 0;
        if (charges > 0) {
            txt += `${mid} *Mugen (Cargas):* ${charges} ♾️\n`;
        } else {
            const cd = user.mugen_cooldown || 0;
            const tLeft = timeLeft(cd); 
            txt += `${mid} *Mugen (Cargas):* 0 ♾️ (Recarrega em ${tLeft})\n`;
        }
    }

    txt += `${mid}\n${mid} Use *.listarclas* para ver todos.\n`;
    txt += `${mid} Use *.girarcla* para trocar (Custo: ${fmt(CUSTO_GIRAR_CLA)} Ouro).\n`;
    txt += `${bot}`;

    await safeSendMessage(sock, chatId, {
        text: txt,
        mentions: [denormalizeJid(authorId)],
    });
}

async function handleGirarCla(message, args, authorId, chatId) {
    const user = usuarios[authorId];
    if ((user.ouro || 0) < CUSTO_GIRAR_CLA) {
        return safeSendMessage(sock, chatId, { text: `Ouro insuficiente! 😥\nCusta: ${fmt(CUSTO_GIRAR_CLA)}\nSeu: ${fmt(user.ouro || 0)}` });
    }

    user.ouro -= CUSTO_GIRAR_CLA;


    const claAtualId = user.cla_id;
    const clasDisponiveis = clas.filter(c => c.id !== claAtualId);
    const now = Date.now();
    const sorteMultiplier = (user.buffs?.pocao_sorte && user.buffs.pocao_sorte > now) ? 2 : 1;
    const claSorteado = sortearCla(clasDisponiveis, sorteMultiplier); 

    if (!claSorteado) {
        user.ouro += CUSTO_GIRAR_CLA; 
        await saveDB(USUARIOS_DB, usuarios);
        return safeSendMessage(sock, chatId, { text: 'Erro ao girar: Não foi possível sortear um clã (DB de clãs vazio ou só existe o seu?). Ouro devolvido.' });
    }


    const oldClaData = clas.find(c => c.id === claAtualId);


    if (oldClaData?.buff?.type === 'skill_start' && oldClaData.buff.skillId) {
        const skillToRemove = oldClaData.buff.skillId;
        user.habilidades = user.habilidades || [];
        
        const skillIndex = user.habilidades.findIndex(h => 
            h.toLowerCase() === skillToRemove.toLowerCase()
        );
        
        if (skillIndex > -1) {
            user.habilidades.splice(skillIndex, 1);
            
            if (user.cooldowns && user.cooldowns[skillToRemove]) {
                delete user.cooldowns[skillToRemove];
            }
            
            console.log(`[GirarCla] Removida skill antiga ${skillToRemove} de ${authorId}`);
        } else {
            console.warn(`[GirarCla] Habilidade ${skillToRemove} não encontrada no array de habilidades do usuário ${authorId}. Array atual:`, user.habilidades);
        }
    }
    if (claAtualId === 'gojo') {
        delete user.mugen_charges;
        delete user.mugen_cooldown;
    }
    
    if (claAtualId === 'meliodas' && user.cooldowns) {
        delete user.cooldowns.reacao_total;
    }
    
    if (claAtualId === 'beyond' && user.cooldowns) {
        delete user.cooldowns.olhos_shinigami;
    }
    
    if (claAtualId === 'saiyajin' && user.cooldowns) {
        delete user.cooldowns.instinto_superior;
    }
    
    if (claAtualId === 'uchiha' && user.cooldowns) {
        delete user.cooldowns.mangekyou_inicial;
    }
    
    if (claAtualId === 'quincy' && user.cooldowns) {
        delete user.cooldowns.blut_vene;
    }
    
    if (claAtualId === 'uchiha_avancado' && user.cooldowns) {
        delete user.cooldowns.amaterasu;
    }
    
    if (claAtualId === 'goku' && user.cooldowns) {
        delete user.cooldowns.kamehameha;
    }
    
    if (claAtualId === 'shinigami_captain' && user.cooldowns) {
        delete user.cooldowns.getsuga_tenshou;
    }


    if (claSorteado.buff?.type === 'skill_start' && claSorteado.buff.skillId) {
        user.habilidades = user.habilidades || [];
        if (!user.habilidades.includes(claSorteado.buff.skillId)) {
            user.habilidades.push(claSorteado.buff.skillId);
        }
    }
    if (claSorteado.id === 'gojo') {
        user.mugen_charges = 1;
        user.mugen_cooldown = Date.now();
    }
    if (claSorteado.id === 'meliodas') {
        user.cooldowns = user.cooldowns || {};
        user.cooldowns.reacao_total = 0;
    }


    const claAnterior = user.cla;
    user.cla = claSorteado.nome;
    user.cla_id = claSorteado.id;

    await saveDB(USUARIOS_DB, usuarios);

    const authorNumber = authorId.split('@')[0];
    const replyText = `🔄 @${authorNumber} gastou ${fmt(CUSTO_GIRAR_CLA)} Ouro!\n\nClã Antigo: *${claAnterior}*\nNovo Clã: *${claSorteado.nome}*\n\nBuff: ${claSorteado.buff?.description || 'Nenhum.'}`;

    await safeSendMessage(sock, chatId, {
        text: replyText,
        mentions: [denormalizeJid(authorId)],
    });
}

async function handleListarClas(message, chatId) {
    const { rarities, total } = getClaRarities(); 
    if (total === 0) return safeSendMessage(sock, chatId, { text: 'Nenhum clã configurado ou todos têm chance 0.' });

    const top = '╭ೋ⛩️ೋ•═══════════╗', mid = '⛩️', bot = '╚═══════════•ೋ⛩️ೋ╯', icon = '🔹';
    let txt = `${top}\n${mid} *Lista de Clãs*\n${mid}\n`;

    const clasOrdenados = [...clas].sort((a, b) => {
        const rarA = rarities[a.id] || 0;
        const rarB = rarities[b.id] || 0;
        return rarA - rarB; 
    });

    for (const claData of clasOrdenados) {
        const percentage = rarities[claData.id] || 0;
        if (percentage === 0) continue; 
        txt += `${mid} ${icon} *${claData.nome}*\n`;
        txt += `${mid}    Buff: ${claData.buff?.description || 'Nenhum.'}\n`;
        txt += `${mid}    Raridade: ${percentage.toFixed(2)}%\n`;
    }
    txt += `${bot}`;
    await safeSendMessage(sock, chatId, { text: txt });
}


async function handleConfigurar(message, chatId) {
    const authorId = normalizeJid(message.key.participant || message.key.remoteJid);
    const userToggles = settings.userToggles || {};
    const rendaNotifState = (userToggles[authorId]?.rendaOff) ? 'OFF' : 'ON';

    const top = '╭ೋ⚙️ೋ•═══════════╗', mid = '⚙️', bot = '╚═══════════•ೋ⚙️ೋ╯', icon = '🔹';

    let txt = `${top}\n${mid} *Menu de Configurações*\n${mid}\n`;
    txt += `${mid} ${icon} *.nick <novo-nome>*\n`;
    txt += `${mid}    (Muda seu nome no RPG. Cooldown: 1 dia)\n`;
    txt += `${mid}\n`;
    txt += `${mid} ${icon} *.set*\n`;
    txt += `${mid}    (Define ESTE grupo para receber suas notificações de renda passiva.)\n`;
    txt += `${mid}\n`;

    txt += `${mid} ${icon} *.renda*\n`;
    txt += `${mid}    (Liga/Desliga as *notificações* de renda passiva. Ouro ainda é ganho.)\n`;
    txt += `${mid}    (Estado Atual: *${rendaNotifState}*)\n`;
    txt += `${bot}`;

    await safeSendMessage(sock, chatId, { text: txt });
}

async function handleNick(message, args, authorId, chatId) {

    const user = usuarios[authorId];
    user.cooldowns = user.cooldowns || {};

    const NICK_COOLDOWN = 24 * 60 * 60 * 1000; 
    const c = user.cooldowns.nick || 0;
    const n = Date.now();
    if (n < c) {
        return safeSendMessage(sock, chatId, { text: `⏳ Você só pode mudar seu nick novamente em ${timeLeft(c)}.` }, { quoted: message });
    }

    const novoNome = args.join(' ');
    if (!novoNome) {
        return safeSendMessage(sock, chatId, { text: 'Qual nome? Use: *.nick <novo-nome>*' }, { quoted: message });
    }

    const nomeAntigo = user.nome;
    user.nome = novoNome;
    user.cooldowns.nick = n + NICK_COOLDOWN;

    await saveDB(USUARIOS_DB, usuarios);

    await safeSendMessage(sock, chatId, { text: `👤 Nome alterado!\n\nAntigo: *${nomeAntigo}*\nNovo: *${novoNome}*` }, { quoted: message });
}

async function handleSetNotifGrupo(message, authorId, chatId) {

    const user = usuarios[authorId];

    if (user.notificationChatId === chatId) {
        return safeSendMessage(sock, chatId, { text: `Este grupo já está definido como seu grupo de notificações.` }, { quoted: message });
    }

    user.notificationChatId = chatId;
    await saveDB(USUARIOS_DB, usuarios);

    let groupName = 'Este grupo';
    try {
        const groupMeta = await safeGroupMetadata(sock, chatId);
        if (groupMeta && groupMeta.subject) {
            groupName = groupMeta.subject;
        }
    } catch (e) { console.warn("Não foi possível pegar o nome do grupo para .set"); }

    await safeSendMessage(sock, chatId, { text: `✅ Sucesso! Você agora receberá suas notificações de renda passiva em *${groupName}*.` }, { quoted: message });
}


async function handleToggleRenda(message, authorId, chatId) {
    settings.userToggles = settings.userToggles || {};
    settings.userToggles[authorId] = settings.userToggles[authorId] || {};

    const currentState = settings.userToggles[authorId]?.rendaOff || false;
    const newState = !currentState;
    settings.userToggles[authorId].rendaOff = newState;

    await saveDB(SETTINGS_DB, settings);

    const msg = newState 
        ? '🔕 Notificações de renda passiva *DESATIVADAS*. (Você continuará ganhando ouro silenciosamente.)'
        : '🔔 Notificações de renda passiva *ATIVADAS*.';

    await safeSendMessage(sock, chatId, { text: msg }, { quoted: message });
}

async function handlePocoes(message, args, authorId, chatId) {
    const user = usuarios[authorId];
    const authorNumber = authorId.split('@')[0];
    
    const potionArg = (args[0] || '').toLowerCase();
    
    if (!potionArg) {
        const top = '╭ೋ🧪ೋ•═══════════╗', mid = '🧪', sep = '════════ •『 💊 』• ════════', bot = '╚═══════════•ೋ🧪ೋ╯', icon = '🔹';
        let txt = `${top}\n${mid} *Loja de Poções @${authorNumber}*\n${mid}\n${mid} ${sep}\n${mid} *Poções Disponíveis*\n`;
        
        const now = Date.now();
        const cooldownSorte = user.pocoesCooldown?.sorte || 0;
        const cooldownDinheiro = user.pocoesCooldown?.dinheiro || 0;
        
        const sorteActive = user.buffs?.pocao_sorte && user.buffs.pocao_sorte > now;
        const dinheiroActive = user.buffs?.pocao_dinheiro && user.buffs.pocao_dinheiro > now;
        
        txt += `${mid}   ${icon} 🧪 *Poção de 2x Sorte* - ${fmt(15000)}💰\n`;
        if (sorteActive) {
            const timeLeft = Math.ceil((user.buffs.pocao_sorte - now) / 1000 / 60);
            txt += `${mid}      ⏳ Ativa! Restam ${timeLeft} minuto(s)\n`;
        } else if (cooldownSorte > now) {
            const timeLeft = Math.ceil((cooldownSorte - now) / 1000 / 60);
            txt += `${mid}      ⏸️ Cooldown: ${timeLeft} minuto(s)\n`;
        } else {
            txt += `${mid}      ✅ Disponível\n`;
        }
        
        txt += `${mid}\n${mid}   ${icon} 💰 *Poção de 2x Dinheiro* - ${fmt(15000)}💰\n`;
        if (dinheiroActive) {
            const timeLeft = Math.ceil((user.buffs.pocao_dinheiro - now) / 1000 / 60);
            txt += `${mid}      ⏳ Ativa! Restam ${timeLeft} minuto(s)\n`;
        } else if (cooldownDinheiro > now) {
            const timeLeft = Math.ceil((cooldownDinheiro - now) / 1000 / 60);
            txt += `${mid}      ⏸️ Cooldown: ${timeLeft} minuto(s)\n`;
        } else {
            txt += `${mid}      ✅ Disponível\n`;
        }
        
        txt += `${mid} ${sep}\n${mid} *Como usar:*\n${mid}   ${icon} .pocoes sorte\n${mid}   ${icon} .pocoes dinheiro\n${mid}\n${mid} *Efeitos:*\n${mid}   ${icon} Sorte: Dobra chances de bom clã (1h)\n${mid}   ${icon} Dinheiro: Dobra ganhos de rendas/menugold (1h)\n${mid}\n${mid} *Cooldown:* 2h por compra\n${bot}`;
        
        await safeSendMessage(sock, chatId, { text: txt }, { quoted: message });
        return;
    }
    
    if (potionArg === 'sorte') {
        const now = Date.now();
        const cooldownSorte = user.pocoesCooldown?.sorte || 0;
        const preco = 15000;
        
        if (cooldownSorte > now) {
            const timeLeft = Math.ceil((cooldownSorte - now) / 1000 / 60);
            return safeSendMessage(sock, chatId, { text: `⏸️ Poção de Sorte em cooldown! Aguarde ${timeLeft} minuto(s).` }, { quoted: message });
        }
        
        if ((user.ouro || 0) < preco) {
            return safeSendMessage(sock, chatId, { text: `💰 Você precisa de ${fmt(preco)} Ouro para comprar esta poção!` }, { quoted: message });
        }
        
        user.ouro = (user.ouro || 0) - preco;
        user.pocoesCooldown = user.pocoesCooldown || {};
        user.pocoesCooldown.sorte = now + (2 * 60 * 60 * 1000);
        user.buffs = user.buffs || {};
        user.buffs.pocao_sorte = now + (60 * 60 * 1000);
        
        await saveDB(USUARIOS_DB, usuarios);
        await safeSendMessage(sock, chatId, { text: `🧪 Poção de 2x Sorte comprada! Suas chances de pegar um bom clã estão duplicadas por 1 hora!` }, { quoted: message });
        return;
    }
    
    if (potionArg === 'dinheiro') {
        const now = Date.now();
        const cooldownDinheiro = user.pocoesCooldown?.dinheiro || 0;
        const preco = 15000;
        
        if (cooldownDinheiro > now) {
            const timeLeft = Math.ceil((cooldownDinheiro - now) / 1000 / 60);
            return safeSendMessage(sock, chatId, { text: `⏸️ Poção de Dinheiro em cooldown! Aguarde ${timeLeft} minuto(s).` }, { quoted: message });
        }
        
        if ((user.ouro || 0) < preco) {
            return safeSendMessage(sock, chatId, { text: `💰 Você precisa de ${fmt(preco)} Ouro para comprar esta poção!` }, { quoted: message });
        }
        
        user.ouro = (user.ouro || 0) - preco;
        user.pocoesCooldown = user.pocoesCooldown || {};
        user.pocoesCooldown.dinheiro = now + (2 * 60 * 60 * 1000);
        user.buffs = user.buffs || {};
        user.buffs.pocao_dinheiro = now + (60 * 60 * 1000);
        
        await saveDB(USUARIOS_DB, usuarios);
        await safeSendMessage(sock, chatId, { text: `💰 Poção de 2x Dinheiro comprada! Seus ganhos de rendas e comandos do .menugold estão duplicados por 1 hora!` }, { quoted: message });
        return;
    }
    
    await safeSendMessage(sock, chatId, { text: `❌ Poção inválida! Use: .pocoes sorte ou .pocoes dinheiro` }, { quoted: message });
}

async function handleVenda(message, args, authorId, chatId) {
    const user = usuarios[authorId];
    const authorNumber = authorId.split('@')[0];
    
    const habId = args[0]?.toLowerCase();
    if (!habId) {
        return safeSendMessage(sock, chatId, { text: `💰 *Vender Habilidade*\n\nUse: *.vender <id_habilidade>*\n\nExemplo: *.vender deathnote*\n\nVocê receberá o valor da habilidade na loja em ouro.` }, { quoted: message });
    }
    
    const hab = (typeof habilidades === 'object' && habilidades) ? habilidades[habId] : null;
    if (!hab) {
        return safeSendMessage(sock, chatId, { text: `❌ Habilidade *${habId}* não encontrada!` }, { quoted: message });
    }
    
    const habIndex = user.habilidades?.findIndex(h => h.toLowerCase() === habId);
    if (habIndex === -1 || habIndex === undefined) {
        return safeSendMessage(sock, chatId, { text: `❌ Você não possui a habilidade *${hab.nome}*!` }, { quoted: message });
    }
    
    if (hab.preco === 0) {
        return safeSendMessage(sock, chatId, { text: `🚫 A habilidade *${hab.nome}* não pode ser vendida (é uma skill de clã ou bônus).` }, { quoted: message });
    }
    
    const precoVenda = hab.preco;
    
    user.habilidades.splice(habIndex, 1);
    user.ouro = (user.ouro || 0) + precoVenda;
    
    await saveDB(USUARIOS_DB, usuarios);
    
    await safeSendMessage(sock, chatId, { 
        text: `✅ *Habilidade Vendida!*\n\n💰 Você vendeu *${hab.nome}* por ${fmt(precoVenda)} Ouro!\n\n💼 Carteira: ${fmt(user.ouro)} Ouro` 
    }, { quoted: message });
}

async function handleUsarHabilidade(message, command, authorId, chatId) {
    const user = usuarios[authorId];
    let userDbChanged = false;
    const hab = (typeof habilidades === 'object' && habilidades) 
        ? habilidades[command] 
        : null;

    if (!hab) {
        console.error(`Erro: Skill ${command} nula.`);
        return safeSendMessage(sock, chatId, { text: `Erro: Skill ${command} nula.` });
    }

    const habIndex = user.habilidades?.findIndex(h => h.toLowerCase() === command);
    if (habIndex === -1 || habIndex === undefined)
        return safeSendMessage(sock, chatId, { text: `Não possui *${hab.nome}*!` });

    const now = Date.now();
    if (user.buffs && user.buffs.aokiji_freeze && user.buffs.aokiji_freeze > now) {
        const timeLeft = Math.ceil((user.buffs.aokiji_freeze - now) / 1000 / 60);
        return safeSendMessage(sock, chatId, { text: `❄️ Você está congelado! Aguarde ${timeLeft} minuto(s) antes de usar habilidades novamente.` }, { quoted: message });
    }

    const originalHabId = user.habilidades[habIndex];
    const reqT = hab.duracao_seg && hab.msg_anular;


    console.log(`[SKILL-DEBUG] Skill: ${command}, reqT: ${reqT}, is_unavoidable: ${hab.is_unavoidable}, timers[chatId]: ${JSON.stringify(timers[chatId])}`);
    if (reqT && timers[chatId] && command !== 'zawarudo' && !hab.is_unavoidable) {
        console.log(`[SKILL-DEBUG] Timer ativo detectado para ${chatId}, bloqueando skill ${command}`);
        return safeSendMessage(sock, chatId, { text: 'Timer ativo!' });
    }


    if (command === 'zawarudo') {

        user.habilidades.splice(habIndex, 1);
        await saveDB(USUARIOS_DB, usuarios);

        await handleZawarudo(message, authorId, chatId, originalHabId);
        return;
    }


    if (hab.affects_all_others) {
        user.habilidades.splice(habIndex, 1); 
        await saveDB(USUARIOS_DB, usuarios);
        await handleSkillArea(message, authorId, chatId, originalHabId, hab, command);
        return;
    }


    if (hab.requires_no_target === true) {
        user.habilidades.splice(habIndex, 1); 
        await saveDB(USUARIOS_DB, usuarios);
        await handleSelfBuffSkill(message, authorId, chatId, hab, command, originalHabId);
        return;
    }


    let rawTargetJid = null;
    let tId = null;
    let targetNumber = null;

    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentionedJids.length === 0) {
        return safeSendMessage(sock, chatId, { text: `Marque um alvo! Uso: *${hab.uso}*` }, { quoted: message });
    }

    rawTargetJid = mentionedJids[0];
    tId = normalizeJid(rawTargetJid);
    targetNumber = rawTargetJid.split('@')[0];

    if (!usuarios[tId]) return safeSendMessage(sock, chatId, { text: 'Alvo não cadastrado.' }, { quoted: message });
    if (tId === authorId) return safeSendMessage(sock, chatId, { text: 'Não pode usar em si mesmo!' }, { quoted: message });


    if (hab.is_info_skill) {
        user.habilidades.splice(habIndex, 1); 
        await saveDB(USUARIOS_DB, usuarios);
        await handleInfoSkill(message, authorId, tId, chatId, hab, command, originalHabId);
        return;
    }


    user.habilidades.splice(habIndex, 1); 
    await saveDB(USUARIOS_DB, usuarios);

    const mId = hab.gif_id || command;
    const vP = path.join(MIDIAS_DIR, `${mId}.mp4`);
    const gP = path.join(MIDIAS_DIR, `${mId}.gif`);
    const authorNumber = authorId.split('@')[0];

    try {
        let cap = `🚨 *HAB. ATIVADA!* 🚨\n\n*${user.nome}* (@${authorNumber}) usou *${hab.nome}* em @${targetNumber}!`;
        const men = [denormalizeJid(authorId), denormalizeJid(tId)];

        if (hab.is_freeze_debuff) {
            const target = usuarios[tId];
            if (target) {
                target.buffs = target.buffs || {};
                const freezeDuration = (hab.freeze_duration_sec || 1800) * 1000;
                target.buffs.aokiji_freeze = Date.now() + freezeDuration;
                userDbChanged = true;
                let msg = hab.msg_sucesso || `❄️ @{atacante} congelou @{alvo}!`;
                msg = msg.replace('{atacante}', authorNumber).replace('{alvo}', targetNumber);
                cap += `\n\n${msg}`;
            }
        }

        if (hab.duracao_seg && hab.msg_anular) {
            cap += `\n\n@${targetNumber}, você tem *${hab.duracao_seg}s* para anular:\n\n*${hab.msg_anular}*`;
        }


        if (hab.is_unavoidable) {
            const target = usuarios[tId];
            const attacker = usuarios[authorId];
            const tO = target.ouro || 0;
            const aO = attacker.ouro || 0;
            const multiplier = hab.multiplier || 1.0;
            
            let oR = 0;
            if (command === 'domino') oR = Math.floor(tO * 0.50);
            else if (command === 'soco_serio') oR = tO;
            else if (command === 'kaikai') oR = Math.floor(tO * 0.24);
            
            target.ouro = tO - oR;
            attacker.ouro = aO + Math.round(oR * multiplier);
            userDbChanged = true;
            
            let msg = hab.msg_sucesso || `Efeito aplicado!`;
            msg = msg.replace('{alvo}', targetNumber).replace('{atacante}', authorNumber).replace('{ouro_roubado}', fmt(oR));
            
            cap += `\n\n${msg}`;
            
            if (userDbChanged) {
                await saveDB(USUARIOS_DB, usuarios);
            }
            
            await enviarMidiaComFallback(chatId, vP, gP, mId, cap, men);
            return;
        }
        
        if (hab.duracao_seg && hab.msg_anular) {
            timers[chatId] = { 
                skillId: command, 
                attackerId: authorId, 
                targetId: tId, 
                chatId: chatId, 
                expires: Date.now() + (hab.duracao_seg * 1000), 
                msg_anular: hab.msg_anular, 
                affects_all_others: false 
            };
            await saveDB(TIMERS_DB, timers);
        } else {
            console.warn(`Skill ${command} é de alvo único mas não tem timer?`);
        }

        if (userDbChanged) {
            await saveDB(USUARIOS_DB, usuarios);
        }

        await enviarMidiaComFallback(chatId, vP, gP, mId, cap, men);

    } catch (sE) {
        console.error(`[SKILL TARGET] Erro ativação ${command}: ${sE.message}`);

        user.habilidades.push(originalHabId);
        await saveDB(USUARIOS_DB, usuarios);
        await safeSendMessage(sock, chatId, { text: `Erro ao usar ${command}. Habilidade devolvida.` });
    }
}


async function handleSelfBuffSkill(message, authorId, chatId, hab, command, originalHabId) {
    const user = usuarios[authorId];
    const authorNumber = authorId.split('@')[0];

    try {
        if (command === 'mahoraga_adapt') {
            const duration = hab.buff_duration_sec || 3600;
            user.buffs = user.buffs || {};
            user.buffs.mahoraga_adapt = Date.now() + (duration * 1000);
            await saveDB(USUARIOS_DB, usuarios);
        }


        const mId = hab.gif_id || command;
        const vP = path.join(MIDIAS_DIR, `${mId}.mp4`);
        const gP = path.join(MIDIAS_DIR, `${mId}.gif`);

        let cap = `✨ *BUFF ATIVADO!* ✨\n\n@${authorNumber} usou *${hab.nome}*!\n\n${hab.msg_sucesso}`;
        const mS = [denormalizeJid(authorId)];

        await enviarMidiaComFallback(chatId, vP, gP, mId, cap, mS); 

    } catch (e) {
         console.error(`!!! Erro enviar self buff ${command}: ${e.message}`);

         user.habilidades.push(originalHabId);
         await saveDB(USUARIOS_DB, usuarios);
         await safeSendMessage(sock, chatId, { text: `Erro ao usar ${command}. Habilidade devolvida.` });
    }
}


async function handleInfoSkill(message, authorId, targetId, chatId, hab, command, originalHabId) {

    try {
        const targetUser = usuarios[targetId];
        if (!targetUser) return; 

        const totalOuro = (targetUser.ouro || 0) + (targetUser.bank || 0);

        const mId = hab.gif_id || command;
        const vP = path.join(MIDIAS_DIR, `${mId}.mp4`);
        const gP = path.join(MIDIAS_DIR, `${mId}.gif`);

        const authorNumber = authorId.split('@')[0];
        const targetNumber = targetId.split('@')[0];

        let cap = `👁️ @${authorNumber} usou *${hab.nome}* em @${targetNumber}!\n\n`;
        cap += `*${hab.msg_sucesso}*\n\n`;
        cap += `📊 *Informações de @${targetNumber}:*\n`;
        cap += `   👤 *Nome:* ${targetUser.nome}\n`;
        cap += `   ⚔️ *Clã:* ${targetUser.cla || 'Nenhum'}\n`;
        cap += `   💰 *Carteira:* ${fmt(targetUser.ouro || 0)} Ouro\n`;
        cap += `   🏦 *Banco:* ${fmt(targetUser.bank || 0)} Ouro`;

        const mS = [denormalizeJid(authorId), denormalizeJid(targetId)];

        await enviarMidiaComFallback(chatId, vP, gP, mId, cap, mS); 

    } catch (e) {
         console.error(`!!! Erro enviar info skill ${command}: ${e.message}`);
         const user = usuarios[authorId];

         if (!hab.is_clan_skill) {
             user.habilidades.push(originalHabId);
             await saveDB(USUARIOS_DB, usuarios);
             await safeSendMessage(sock, chatId, { text: `Erro ao usar ${command}. Habilidade devolvida.` });
         } else {
             await safeSendMessage(sock, chatId, { text: `Erro ao usar ${command}.` });
         }
    }
}


async function handleZawarudo(message, authorId, chatId, originalHabId) {

    const habDef = habilidades?.['zawarudo'] || {};
    const durationMs = (habDef?.duracao_seg ? habDef.duracao_seg * 1000 : 60_000);

    const authorDenorm = denormalizeJid(authorId); 
    const authorNumber = authorId.split('@')[0];


    const affectedPromoted = [];
    const appliedSettings = []; 

    try {

        try {
            await sock.groupSettingUpdate(chatId, 'announcement'); 
            appliedSettings.push('announcement');
            console.log(`[ZA WARUDO] groupSettingUpdate(announcement) ok for ${chatId}`);
        } catch (e) {
            console.warn(`[ZA WARUDO] Falha ao fechar grupo (announcement): ${e.message}`);
        }


        try {
            await sock.groupSettingUpdate(chatId, 'locked');
            appliedSettings.push('locked');
            console.log(`[ZA WARUDO] groupSettingUpdate(locked) ok for ${chatId}`);
        } catch (e) {
            console.warn(`[ZA WARUDO] Falha ao lockar grupo: ${e.message}`);
        }


        try {
            await sock.groupParticipantsUpdate(chatId, [authorDenorm], 'promote');
            affectedPromoted.push(authorDenorm);
            console.log(`[ZA WARUDO] Promoted ${authorDenorm} in ${chatId}`);
        } catch (e) {
            console.warn(`[ZA WARUDO] Falha ao promover ${authorDenorm}: ${e.message}`);
        }


        timers[chatId] = {
            skillId: 'zawarudo',
            attackerId: authorId,
            targetId: null,
            chatId,
            expires: Date.now() + durationMs,
            msg_anular: null,
            affects_all_others: true,
            softMode: false, 
            affectedPromoted,
            appliedSettings
        };
        await saveDB(TIMERS_DB, timers);


        const mId = habDef.gif_id || 'zawarudo';
        const vP = path.join(MIDIAS_DIR, `${mId}.mp4`);
        const gP = path.join(MIDIAS_DIR, `${mId}.gif`);


        const cap = `⏰ *ZA WARUDO!* ⏰\n@${authorNumber} parou o tempo! O grupo foi fechado por 1 hora!`;


        await enviarMidiaComFallback(chatId, vP, gP, mId, cap, [authorDenorm]);


    } catch (e) {
        console.error(`[ZA WARUDO] Erro grave ao executar: ${e.message}`);

        timers[chatId] = {
            skillId: 'zawarudo',
            attackerId: authorId,
            targetId: null,
            chatId,
            expires: Date.now() + durationMs,
            msg_anular: null,
            affects_all_others: true,
            softMode: true, 
            affectedPromoted: [],
            appliedSettings: []
        };
        await saveDB(TIMERS_DB, timers);
        await safeSendMessage(sock, chatId, { text: `⚠️ ZA WARUDO executado apenas internamente devido a erro.` });
    }
}

async function handleSkillArea(message, authorId, chatId, originalHabId, hab, command) {


    const user = usuarios[authorId];
    const authorNumber = authorId.split('@')[0];

    try {
        const vP = path.join(MIDIAS_DIR, `${hab.gif_id || command}.mp4`);
        const gP = path.join(MIDIAS_DIR, `${hab.gif_id || command}.gif`);

        let cap = `🚨 *HAB. EM ÁREA ATIVADA!* 🚨\n\n*${user.nome}* (@${authorNumber}) usou *${hab.nome}*!`;
        const men = [denormalizeJid(authorId)];

        if (hab.duracao_seg && hab.msg_anular) {
            cap += `\n\nTodos têm *${hab.duracao_seg}s* p/ anular:\n\n*${hab.msg_anular}*`;
        }

        await enviarMidiaComFallback(chatId, vP, gP, (hab.gif_id || command), cap, men); 


        if (hab.duracao_seg && hab.msg_anular) {
            timers[chatId] = { skillId: command, attackerId: authorId, targetId: null, chatId: chatId, expires: Date.now() + (hab.duracao_seg * 1000), msg_anular: hab.msg_anular, affects_all_others: true };
            await saveDB(TIMERS_DB, timers);
        } else {

            timers[chatId] = { skillId: command, attackerId: authorId, targetId: null, chatId: chatId, expires: Date.now() + 1000, msg_anular: null, affects_all_others: true, is_unavoidable: hab.is_unavoidable };
            await saveDB(TIMERS_DB, timers);
        }

    } catch (sE) {
        console.error(`[SKILL AREA] Erro ativação ${command}: ${sE.message}`);
        let fC = `💥(Erro Mídia)\n\n*${user.nome}* usou *${hab.nome}*!`;
        if (hab.duracao_seg && hab.msg_anular) {
             fC += ` ${hab.duracao_seg}s p/ anular: *${hab.msg_anular}*`;
        }
        await safeSendMessage(sock, chatId, { text: fC, mentions: [denormalizeJid(authorId)] });


        if (hab.duracao_seg && hab.msg_anular) {
             timers[chatId] = { skillId: command, attackerId: authorId, targetId: null, chatId: chatId, expires: Date.now() + (hab.duracao_seg * 1000), msg_anular: hab.msg_anular, affects_all_others: true };
        } else {
             timers[chatId] = { skillId: command, attackerId: authorId, targetId: null, chatId: chatId, expires: Date.now() + 1000, msg_anular: null, affects_all_others: true, is_unavoidable: hab.is_unavoidable };
        }
        await saveDB(TIMERS_DB, timers);
    }
}


async function handleUsarHabilidadeCla(message, command, authorId, chatId) {
    const user = usuarios[authorId];
    const hab = (typeof habilidades === 'object' && habilidades) 
        ? habilidades[command] 
        : null;

    if (!hab || !hab.is_clan_skill) {
        console.error(`Erro: Skill de clã ${command} nula ou mal configurada.`);
        return safeSendMessage(sock, chatId, { text: `Erro: Skill de clã ${command} nula.` });
    }


    const habIndex = user.habilidades?.findIndex(h => h.toLowerCase() === command);
    if (habIndex === -1 || habIndex === undefined)
        return safeSendMessage(sock, chatId, { text: `Você não deveria ter *${hab.nome}*! (Não pertence ao clã?)` });

    const originalHabId = user.habilidades[habIndex];

    const now = Date.now();
    if (user.buffs && user.buffs.aokiji_freeze && user.buffs.aokiji_freeze > now) {
        const timeLeft = Math.ceil((user.buffs.aokiji_freeze - now) / 1000 / 60);
        return safeSendMessage(sock, chatId, { text: `❄️ Você está congelado! Aguarde ${timeLeft} minuto(s) antes de usar habilidades novamente.` }, { quoted: message });
    }

    user.cooldowns = user.cooldowns || {};
    const n = Date.now();
    const cdKey = command.startsWith('.') ? command.substring(1) : command; 
    const cd = user.cooldowns[cdKey] || 0;

    if (n < cd) {
        return safeSendMessage(sock, chatId, { text: `⏳ Habilidade *${hab.nome}* em cooldown! (${timeLeft(cd)})` }, { quoted: message });
    }


    const C = (hab.cooldown_sec || 300) * 1000; 
    user.cooldowns[cdKey] = n + C;
    await saveDB(USUARIOS_DB, usuarios); 


    if (hab.requires_no_target === true) {
        await handleSelfBuffSkill(message, authorId, chatId, hab, command, originalHabId);
        return;
    }


    let rawTargetJid = null;
    let tId = null;

    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentionedJids.length === 0) {
        return safeSendMessage(sock, chatId, { text: `Marque um alvo! Uso: *${hab.uso}*` }, { quoted: message });
    }

    rawTargetJid = mentionedJids[0];
    tId = normalizeJid(rawTargetJid);

    if (!usuarios[tId]) return safeSendMessage(sock, chatId, { text: 'Alvo não cadastrado.' }, { quoted: message });
    if (tId === authorId) return safeSendMessage(sock, chatId, { text: 'Não pode usar em si mesmo!' }, { quoted: message });


    if (hab.is_info_skill) {
        await handleInfoSkill(message, authorId, tId, chatId, hab, command, originalHabId);
        return;
    }


    const mId = hab.gif_id || command;
    const vP = path.join(MIDIAS_DIR, `${mId}.mp4`);
    const gP = path.join(MIDIAS_DIR, `${mId}.gif`);
    const authorNumber = authorId.split('@')[0];
    const targetNumber = rawTargetJid.split('@')[0];

    try {
        let cap = `⛩️ *HAB. DE CLÃ!* ⛩️\n\n*${user.nome}* (@${authorNumber}) usou *${hab.nome}* em @${targetNumber}!`;
        const men = [denormalizeJid(authorId), denormalizeJid(tId)];

        if (hab.duracao_seg && hab.msg_anular) {
            cap += `\n\n@${targetNumber}, você tem *${hab.duracao_seg}s* para anular:\n\n*${hab.msg_anular}*`;
        }


        if (hab.duracao_seg && hab.msg_anular) {
            timers[chatId] = { 
                skillId: command, 
                attackerId: authorId, 
                targetId: tId,
                chatId: chatId, 
                expires: Date.now() + (hab.duracao_seg * 1000), 
                msg_anular: hab.msg_anular, 
                affects_all_others: false
            };
            await saveDB(TIMERS_DB, timers);
        }

        await enviarMidiaComFallback(chatId, vP, gP, mId, cap, men);

    } catch (sE) {
        console.error(`[SKILL CLAN] Erro ativação ${command}: ${sE.message}`);

        await safeSendMessage(sock, chatId, { text: `Erro ao usar ${command}.` });
    }
}


async function handleBanco(m, a, chatId) {
    const u = usuarios[a];
    u.bank = u.bank || 0;
    await safeSendMessage(sock, chatId, { text: `🏦 *Banco*\nSaldo: ${fmt(u.bank)} Ouro` });
}

async function handleCarteira(m, a, chatId) {
    const u = usuarios[a];
    const text = `💰 *Carteira*\n\nCarteira: ${fmt(u.ouro || 0)} 💰\nBanco: ${fmt(u.bank || 0)} 🏦`;
    await safeSendMessage(sock, chatId, { text: text }, { quoted: m });
}

async function handleDepositar(m, g, a, chatId) {

    const u = usuarios[a];
    u.ouro = u.ouro || 0;
    u.bank = u.bank || 0;
    u.cooldowns = u.cooldowns || {};

    const DEPOSIT_COOLDOWN = 1 * 60 * 60 * 1000; 
    const c = u.cooldowns.deposit || 0;
    const n = Date.now();
    if (n < c) {
        return safeSendMessage(sock, chatId, { text: `⏳ Você só pode depositar novamente em ${timeLeft(c)}.` }, { quoted: m });
    }

    const o = parseAmount(g[0], u.ouro); 
    if (!isFinite(o) || o <= 0) return safeSendMessage(sock, chatId, { text: `🤔 Valor inválido! Use *.depositar <valor | all>*` }, { quoted: m });
    if (o > u.ouro) return safeSendMessage(sock, chatId, { text: `😥 Você não tem ${fmt(o)} Ouro.` }, { quoted: m });

    u.ouro -= o;
    u.bank += o;
    u.cooldowns.deposit = n + DEPOSIT_COOLDOWN; 

    await saveDB(USUARIOS_DB, usuarios);
    await safeSendMessage(sock, chatId, { text: `✅ Depositado ${fmt(o)}.\nCarteira: ${fmt(u.ouro)}\nBanco: ${fmt(u.bank)}` });
}

async function handleSacar(m, g, a, chatId) {

    const u = usuarios[a];
    u.ouro = u.ouro || 0;
    u.bank = u.bank || 0;
    const o = parseAmount(g[0], u.bank); 
    if (!isFinite(o) || o <= 0) return safeSendMessage(sock, chatId, { text: `🤔 Valor inválido! Use *.sacar <valor | all>*` }, { quoted: m });
    if (o > u.bank) return safeSendMessage(sock, chatId, { text: `😥 Saldo insuficiente (${fmt(u.bank)}).` }, { quoted: m });
    u.bank -= o;
    u.ouro += o;
    await saveDB(USUARIOS_DB, usuarios);
    await safeSendMessage(sock, chatId, { text: `✅ Sacado ${fmt(o)}.\nCarteira: ${fmt(u.ouro)}\nBanco: ${fmt(u.bank)}` });
}

async function handlePix(m, args, authorId, chatId) {

    const u = usuarios[authorId];
    u.cooldowns = u.cooldowns || {};

    const PIX_COOLDOWN = 30 * 60 * 1000; 
    const c = u.cooldowns.pix || 0;
    const n = Date.now();
    if (n < c) {
        return safeSendMessage(sock, chatId, { text: `⏳ Você só pode fazer *.pix* novamente em ${timeLeft(c)}.` }, { quoted: m });
    }

    const amount = parseAmount(args[0], u.ouro); 

    let rawTargetJid = null;
    let tId = null;
    let targetNumber = null;

    const mentionedJids = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentionedJids.length === 0) {
        return safeSendMessage(sock, chatId, { text: `Marque o usuário para quem quer transferir! Use: *.pix <valor> @alvo*` }, { quoted: m });
    }

    rawTargetJid = mentionedJids[0];
    tId = normalizeJid(rawTargetJid);
    targetNumber = rawTargetJid.split('@')[0];

    const targetUser = usuarios[tId];
    if (!targetUser) return safeSendMessage(sock, chatId, { text: 'Alvo não cadastrado.' }, { quoted: m });
    if (tId === authorId) return safeSendMessage(sock, chatId, { text: 'Não pode transferir para si mesmo!' }, { quoted: m });

    if (!isFinite(amount) || amount <= 0) return safeSendMessage(sock, chatId, { text: `🤔 Valor inválido! Use *.pix <valor | all> @alvo*` }, { quoted: m });
    if (amount > u.ouro) return safeSendMessage(sock, chatId, { text: `😥 Você não tem ${fmt(amount)} Ouro na carteira.` }, { quoted: m });

    u.ouro -= amount;
    targetUser.ouro = (targetUser.ouro || 0) + amount;
    u.cooldowns.pix = n + PIX_COOLDOWN;

    await saveDB(USUARIOS_DB, usuarios);

    const authorNumber = authorId.split('@')[0];
    const replyText = `💸 *Transferência PIX*\n\n@${authorNumber} enviou *${fmt(amount)} Ouro* para @${targetNumber}!`;

    await safeSendMessage(sock, chatId, {
        text: replyText,
        mentions: [denormalizeJid(authorId), denormalizeJid(tId)],
    });
}


async function handleAddMoney(m, g, a, chatId) {
    let targetId = a; 
    let amountStr = g[0];

    const mentionedJids = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    if (mentionedJids.length > 0) {

        amountStr = g[0];
        targetId = normalizeJid(mentionedJids[0]);
    } else if (g.length > 1) {


         if (g[1].includes('@c.us') || g[1].includes('@s.whatsapp.net')) {
             amountStr = g[0];
             targetId = normalizeJid(g[1]);
         }
    }

    const u = usuarios[targetId];
    if (!u) {
        return safeSendMessage(sock, chatId, { text: 'Alvo não encontrado no DB.' }, { quoted: m });
    }

    const amount = parseInt(amountStr);
    if (isNaN(amount)) { 
        return safeSendMessage(sock, chatId, { text: 'Valor inválido. Use *.add <quantidade> [@alvo]*' }, { quoted: m });
    }

    u.ouro = (u.ouro || 0) + amount;
    await saveDB(USUARIOS_DB, usuarios);

    const action = amount > 0 ? "Adicionado" : "Removido";
    const amountAbs = Math.abs(amount);

    await safeSendMessage(sock, chatId, { text: `✅ (ADM) ${action} ${fmt(amountAbs)} Ouro.\nAlvo: *${u.nome}*\nNovo saldo: ${fmt(u.ouro)}` }, { quoted: m });
}


async function handleDiario(message, authorId, chatId) {
    const user = usuarios[authorId];
    user.cooldowns = user.cooldowns || {};


    const today = getDateInBrasilia(); 

    if (user.cooldowns.diario === today) {
        return safeSendMessage(sock, chatId, { text: `Você já pegou seu prêmio diário hoje! Volte amanhã.` }, { quoted: message });
    }

    const premioBase = Math.floor(Math.random() * 4001) + 1000;
    const dinheiroMultiplier = (user.buffs?.pocao_dinheiro && user.buffs.pocao_dinheiro > Date.now()) ? 2 : 1;
    const premio = Math.round(premioBase * dinheiroMultiplier);
    user.ouro = (user.ouro || 0) + premio;


    user.cooldowns.diario = today;

    await saveDB(USUARIOS_DB, usuarios);

    await safeSendMessage(sock, chatId, {
        text: `🎁 *Prêmio Diário!*\nVocê recebeu *${fmt(premio)}* de Ouro!`,
        mentions: [denormalizeJid(authorId)]
    }, { quoted: message });
}

async function handleTrabalhar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.work || 0, n = Date.now(), C = 7 * 60 * 1000;
    if (n < c) return safeSendMessage(sock, chatId, { text: `⏳ Descanse! Volte em ${timeLeft(c)}.` }, { quoted: m });

    const b = 180 + Math.floor(Math.random() * 181); 
    const l = getBuffMultiplier(u, 'activity_bonus');
    const dinheiroMultiplier = (u.buffs?.pocao_dinheiro && u.buffs.pocao_dinheiro > Date.now()) ? 2 : 1;
    const t = Math.round(b * l * dinheiroMultiplier);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.work = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await safeSendMessage(sock, chatId, { text: `💼 Trabalhou e ganhou ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handleMinerar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.mine || 0, n = Date.now(), C = 5 * 60 * 1000;
    if (n < c) return safeSendMessage(sock, chatId, { text: `⏳ Mina esgotada! Volte em ${timeLeft(c)}.` }, { quoted: m });

    const g = 110 + Math.floor(Math.random() * 111); 
    const l = getBuffMultiplier(u, 'activity_bonus');
    const dinheiroMultiplier = (u.buffs?.pocao_dinheiro && u.buffs.pocao_dinheiro > Date.now()) ? 2 : 1;
    const t = Math.round(g * l * dinheiroMultiplier);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.mine = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await safeSendMessage(sock, chatId, { text: `⛏️ Minerou ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handlePescar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.fish || 0, n = Date.now(), C = 6 * 60 * 1000;
    if (n < c) return safeSendMessage(sock, chatId, { text: `⏳ Peixes sumiram! Volte em ${timeLeft(c)}.` }, { quoted: m });

    const g = 140 + Math.floor(Math.random() * 141); 
    const l = getBuffMultiplier(u, 'activity_bonus');
    const dinheiroMultiplier = (u.buffs?.pocao_dinheiro && u.buffs.pocao_dinheiro > Date.now()) ? 2 : 1;
    const t = Math.round(g * l * dinheiroMultiplier);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.fish = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await safeSendMessage(sock, chatId, { text: `🎣 Vendeu peixes por ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handleFazerBolo(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.fazerbolo || 0, n = Date.now(), C = 6 * 60 * 1000;
    if (n < c) return safeSendMessage(sock, chatId, { text: `⏳ Cozinha bagunçada! Volte em ${timeLeft(c)}.` }, { quoted: m });

    u.cooldowns.fazerbolo = n + C;

    if (Math.random() < 0.5) {
        const baseGain = 130 + Math.floor(Math.random() * 131); 
        const activityMultiplier = getBuffMultiplier(u, 'activity_bonus');
        const dinheiroMultiplier = (u.buffs?.pocao_dinheiro && u.buffs.pocao_dinheiro > Date.now()) ? 2 : 1;
        const totalGain = Math.round(baseGain * activityMultiplier * dinheiroMultiplier);

        u.ouro = (u.ouro || 0) + totalGain;
        await saveDB(USUARIOS_DB, usuarios);
        await safeSendMessage(sock, chatId, { text: `🎂 ${u.nome} fez um bolo de baunilha delicioso e ganhou ${fmt(totalGain)} Ouro!${activityMultiplier > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
    } else {
        await saveDB(USUARIOS_DB, usuarios);
        await safeSendMessage(sock, chatId, { text: `😷 ${u.nome} tentou fazer um bolo e acabou criando um bolo de cocô 💩 kkkkk` }, { quoted: m });
    }
}

async function handleForjar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.forjar || 0, n = Date.now(), C = 6 * 60 * 1000;
    if (n < c) return safeSendMessage(sock, chatId, { text: `⏳ Fornalha fria! Volte em ${timeLeft(c)}.` }, { quoted: m });

    u.cooldowns.forjar = n + C;

    const isTsugikuni = u.cla_id === 'tsugikuni';

    if (isTsugikuni || Math.random() < 0.5) {
        const baseGain = 140 + Math.floor(Math.random() * 141); 
        let activityMultiplier = getBuffMultiplier(u, 'activity_bonus');
        let forjarMultiplier = 1.0;
        let bonusMsg = "";

        if (isTsugikuni) {
            const claBuff = clas.find(c => c.id === 'tsugikuni')?.buff;
            forjarMultiplier = claBuff?.multiplier || 3.0;
            bonusMsg = " (Respiração do Sol x3!)";
        }
        if (activityMultiplier > 1.0 && bonusMsg === "") bonusMsg = " (Bônus!)";

        const dinheiroMultiplier = (u.buffs?.pocao_dinheiro && u.buffs.pocao_dinheiro > Date.now()) ? 2 : 1;
        const totalGain = Math.round(baseGain * activityMultiplier * forjarMultiplier * dinheiroMultiplier);
        u.ouro = (u.ouro || 0) + totalGain;
        await saveDB(USUARIOS_DB, usuarios);
        await safeSendMessage(sock, chatId, { text: `🔥 Forja bem-sucedida! Você criou uma lâmina e vendeu por ${fmt(totalGain)} Ouro!${bonusMsg}` }, { quoted: m });
    } else {
        await saveDB(USUARIOS_DB, usuarios);
        await safeSendMessage(sock, chatId, { text: `💥 Falha! A lâmina quebrou na forja. Você não ganhou nada e perdeu materiais.` }, { quoted: m });
    }
}


async function handleExplorar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.explore || 0, n = Date.now(), C = 8 * 60 * 1000;
    if (n < c) return safeSendMessage(sock, chatId, { text: `⏳ Área perigosa! Volte em ${timeLeft(c)}.` }, { quoted: m });

    const g = 220 + Math.floor(Math.random() * 221); 
    const l = getBuffMultiplier(u, 'activity_bonus');
    const dinheiroMultiplier = (u.buffs?.pocao_dinheiro && u.buffs.pocao_dinheiro > Date.now()) ? 2 : 1;
    const t = Math.round(g * l * dinheiroMultiplier);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.explore = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await safeSendMessage(sock, chatId, { text: `🧭 Explorou e achou ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handleCaçar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.hunt || 0, n = Date.now(), C = 9 * 60 * 1000;
    if (n < c) return safeSendMessage(sock, chatId, { text: `⏳ Animais fugiram! Volte em ${timeLeft(c)}.` }, { quoted: m });

    const g = 260 + Math.floor(Math.random() * 261); 
    const l = getBuffMultiplier(u, 'activity_bonus');
    const dinheiroMultiplier = (u.buffs?.pocao_dinheiro && u.buffs.pocao_dinheiro > Date.now()) ? 2 : 1;
    const t = Math.round(g * l * dinheiroMultiplier);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.hunt = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await safeSendMessage(sock, chatId, { text: `🏹 Caçou e vendeu peles por ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handleCrime(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.crime || 0, n = Date.now(), C = 10 * 60 * 1000;
    if (n < c) return safeSendMessage(sock, chatId, { text: `⏳ Disfarce! Espere ${timeLeft(c)}.` }, { quoted: m });

    let sC = 0.4, gM = 1.0, bonusMsg = "";


    if (u.cla_id === 'demonio') {
        sC = 1.0; 
        const d = clas.find(c => c.id === 'demonio');
        gM = d?.buff?.multiplier || 1.5; 
        bonusMsg = " (Bônus de Oni!)";
    }

    const suc = Math.random() < sC;
    const actM = getBuffMultiplier(u, 'activity_bonus');
    if (actM > 1.0 && bonusMsg === "") bonusMsg = " (Bônus!)";

    if (suc) {
        const bG = 70 + Math.floor(Math.random() * 141);
        const dinheiroMultiplier = (u.buffs?.pocao_dinheiro && u.buffs.pocao_dinheiro > Date.now()) ? 2 : 1;
        const tG = Math.round(bG * actM * gM * dinheiroMultiplier);
        u.ouro = (u.ouro || 0) + tG;
        u.cooldowns.crime = n + C;
        await saveDB(USUARIOS_DB, usuarios);
        await safeSendMessage(sock, chatId, { text: `💰 Crime perfeito! Lucrou ${fmt(tG)} Ouro.${bonusMsg}` }, { quoted: m });
    } else {
        const f = 35 + Math.floor(Math.random() * 71); 
        const p = Math.min(u.ouro || 0, f);
        u.ouro = (u.ouro || 0) - p;
        u.cooldowns.crime = n + C;
        await saveDB(USUARIOS_DB, usuarios);
        await safeSendMessage(sock, chatId, { text: `🚓 Pego! Multa de ${fmt(p)} Ouro.` }, { quoted: m });
    }
}

async function handleMenuGold(message, authorId, chatId) {

    const user = usuarios[authorId];
    const authorNumber = authorId.split('@')[0];
    const top = '╭ೋ🪙ೋ•═══════════╗', mid = '🪙', sep = '════════ •『 💰 』• ════════', bot = '╚═══════════•ೋ🪙ೋ╯', icon = '✨';


    let txt = `${top}\n${mid} *Menu Economia @${authorNumber}*\n${mid}\n${mid} *Ouro:*\n${mid}   ${icon} Carteira: ${fmt(user.ouro || 0)}💰\n${mid}   ${icon} Banco: ${fmt(user.bank || 0)}🏦\n${mid} ${sep}\n${mid} *Banco/Transferência:*\n${mid}   ${icon} .banco\n${mid}   ${icon} .depositar <v|all>\n${mid}   ${icon} .sacar <v|all>\n`;
    txt += `${mid}   ${icon} .carteira\n`; 
    txt += `${mid}   ${icon} .trade <id> @alvo\n`; 
    txt += `${mid}   ${icon} .pix <v|all> @alvo\n${mid} ${sep}\n${mid} *Ganhos:*\n${mid}   ${icon} .diario\n${mid}   ${icon} .trabalhar\n${mid}   ${icon} .minerar\n${mid}   ${icon} .pescar\n${mid}   ${icon} .forjar\n${mid}   ${icon} .fazerbolo\n${mid}   ${icon} .explorar\n${mid}   ${icon} .caçar\n${mid}   ${icon} .crime\n${mid} ${sep}\n${mid} *Venda:*\n${mid}   ${icon} .vender <id_habilidade>\n${mid} ${sep}\n`;


    txt += `${mid} *Comércio & Clãs:*\n`;
    txt += `${mid}   ${icon} .loja\n`;
    txt += `${mid}   ${icon} .habilidades\n`;
    txt += `${mid}   ${icon} .clas\n`;
    txt += `${mid}   ${icon} .girarcla (Custo: ${fmt(CUSTO_GIRAR_CLA)})\n`;
    txt += `${mid}   ${icon} .listarclas\n`;
    txt += `${mid}   ${icon} .menu\n`;
    txt += `${mid}   ${icon} .configurar\n${bot}`;


    const vP = path.join(MIDIAS_DIR, 'menugold.mp4');
    const gP = path.join(MIDIAS_DIR, 'menugold.gif');
    const iP = path.join(MIDIAS_DIR, 'menugold.jpg');

    await enviarMidiaComFallback(chatId, vP, gP, 'menugold', txt, [denormalizeJid(authorId)], iP);
}


async function passiveIncomeLoop(sockInstance) {
    if (!sockInstance) return;
    const now = Date.now();
    let payoutDbChanged = false;
    let userDbChanged = false;

    for (const userId in payouts) {
        if (!usuarios[userId]) {
            console.warn(`[LOOP] Limpando payouts de usuário órfão: ${userId}`);
            delete payouts[userId];
            payoutDbChanged = true;
            continue;
        }

        const user = usuarios[userId];
        const userPayouts = payouts[userId];

        for (const itemId in userPayouts) {
            const nextPaymentTime = userPayouts[itemId];

            if (now >= nextPaymentTime) {
                try {
                    const { item: itemData, catId } = findItemInLoja(itemId, true);
                    if (!itemData) {
                        console.warn(`Item ${itemId} não existe mais. Removendo de ${user.nome}.`);
                        delete userPayouts[itemId];
                        user.passivos = user.passivos.filter(p => p.id !== itemId);
                        payoutDbChanged = true;
                        userDbChanged = true;
                        continue;
                    }


                    let c = itemData.cooldown_min * 60000;
                    let cM = getBuffMultiplier(user, 'cooldown_reduction'); 
                    c *= cM;
                    const cFinal = Math.max(10000, c); 


                    userPayouts[itemId] = now + cFinal;
                    payoutDbChanged = true;


                    let r = itemData.renda;
                    let iM = getBuffMultiplier(user, 'passive_income_boost');
                    let bonusMsg = "";

                    if (user.cla_id === 'tsugikuni' && catId === 'demon_slayer') {
                        r *= 1.50; 
                        iM = 1.0;
                        bonusMsg = ' (Respiração do Sol!)';
                    }

                    r *= iM;
                    if (iM > 1.0) bonusMsg = ' (Bônus Uzumaki!)';
                    
                    const dinheiroMultiplier = (user.buffs?.pocao_dinheiro && user.buffs.pocao_dinheiro > now) ? 2 : 1;
                    r *= dinheiroMultiplier;

                    const rF = Math.round(r);
                    user.ouro = (user.ouro || 0) + rF;
                    userDbChanged = true;


                    const userToggles = settings.userToggles || {};
                    const notifOff = userToggles[userId]?.rendaOff || false;

                    if (notifOff) {
                        console.log(`[LOOP] Pago ${fmt(rF)} (silenciosamente) para ${user.nome} (item ${itemId})`);
                        continue;
                    }


                    const targetChatId = user.notificationChatId || user.lastKnownChatId;
                    if (targetChatId) {

                        let msg = itemData.mensagem_ganho.replace('{nome}', user.nome).replace('{renda}', fmt(rF));
                        msg += bonusMsg;

                        const mediaId = itemData.gif_id || itemId;
                        const vP = path.join(MIDIAS_DIR, `${mediaId}.mp4`);
                        const gP = path.join(MIDIAS_DIR, `${mediaId}.gif`);


                        enviarMidiaComFallback(targetChatId, vP, gP, mediaId, msg, []);

                    } else console.warn(`User ${user.nome}(${userId}) sem chat para renda.`);

                } catch (lE) {
                    console.error(`!!! ERRO RENDA ${user.nome}(${userId}), item ${itemId}: ${lE.message}`);

                    userPayouts[itemId] = now + (15 * 60 * 1000);
                    payoutDbChanged = true;
                }
            }
        }
    }

    if (payoutDbChanged) await saveDB(PAYOUTS_DB, payouts);
    if (userDbChanged) await saveDB(USUARIOS_DB, usuarios);
}


async function clanCooldownLoop(sockInstance) {
    if (!sockInstance) return;
    const now = Date.now();
    let dbChanged = false;

    for (const userId in usuarios) {
        const user = usuarios[userId];


        if (user.cla_id === 'gojo') {
            const charges = user.mugen_charges || 0;
            const cd = user.mugen_cooldown || 0;
            if (charges < 1 && now >= cd) {
                user.mugen_charges = 1;

                user.mugen_cooldown = now + (2 * 60 * 60 * 1000); 
                dbChanged = true;
                console.log(`[LOOP CLÃ] Carga de Mugen regenerada para ${user.nome} (${userId})`);

            }
        }


        if (user.cla_id === 'saiyajin') {


        }
    }

    if (dbChanged) {
        await saveDB(USUARIOS_DB, usuarios);
    }
}


let lastCheckedHour = -1;

async function checkDailyDiscountLoop() {
    const now = new Date();
    const brasiliaTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const currentHour = brasiliaTime.getHours();
    const currentMinute = brasiliaTime.getMinutes();
    
    if (currentHour === 0 && currentMinute < 5 && lastCheckedHour !== 0) {
        lastCheckedHour = 0;
        console.log('[DISCOUNT] Meia-noite detectada! Verificando desconto...');
        await checkDailyDiscount(true);
    } else if (currentHour !== 0) {
        lastCheckedHour = currentHour;
    }
}

async function checkDailyDiscount(shouldNotify = false) {
    console.log('[DISCOUNT] Verificando desconto diário...');

    const today = getDateInBrasilia(); 

    if (settings.lastDiscountDate !== today) {
        console.log(`[DISCOUNT] Novo dia (${today})! Sorteando novo desconto...`);
        settings.lastDiscountDate = today;


        if (!habilidades || typeof habilidades !== 'object' || Object.keys(habilidades).length === 0) {
            console.error('[DISCOUNT] ERRO: A variável "habilidades" não está carregada corretamente!');
            console.warn('[DISCOUNT] Pulando sorteio de desconto. Verifique se habilidades.json foi carregado.');

            await saveDB(SETTINGS_DB, settings);
            return; 
        }


        const habilidadesArray = Object.entries(habilidades).map(([id, hab]) => ({
            id,
            ...hab
        })).filter(h => h.preco > 0);


        if (habilidadesArray.length === 0) {
            console.warn('[DISCOUNT] Nenhuma habilidade encontrada para sortear desconto.');
            await saveDB(SETTINGS_DB, settings);
            return; 
        }

        const habilidadeSorteada = habilidadesArray[Math.floor(Math.random() * habilidadesArray.length)];

        const expiresAt = Date.now() + (24 * 60 * 60 * 1000);

        settings.dailyDiscount = {
            id: habilidadeSorteada.id,
            expires: expiresAt
        };

        await saveDB(SETTINGS_DB, settings);
        console.log(`[DISCOUNT] Desconto de 50% aplicado na habilidade "${habilidadeSorteada.nome}" (ID: ${habilidadeSorteada.id}).`);

        if (shouldNotify && sock) {
            await notifyAllGroupsAboutDiscount(habilidadeSorteada);
        }

    } else {
        console.log(`[DISCOUNT] Desconto do dia (${today}) já aplicado.`);
    }
}

async function notifyAllGroupsAboutDiscount(hab) {
    try {
        const groupArray = Array.from(knownGroups);
        
        if (groupArray.length === 0) {
            console.warn(`[DISCOUNT] Nenhum grupo conhecido encontrado para notificar.`);
            return;
        }

        console.log(`[DISCOUNT] Notificando ${groupArray.length} grupos sobre o desconto...`);

        const comandoUso = hab.requires_no_target === true 
            ? `.${hab.id}` 
            : hab.is_info_skill 
                ? `.${hab.id} @usuario`
                : hab.uso || `.${hab.id} @usuario`;

        const notificationText = `🎉 *OFERTA DO DIA!* 🎉\n\n` +
            `💰 *${hab.nome}*\n` +
            `🎬 *${hab.anime}*\n` +
            `💸 Preço: ${fmt(Math.floor(hab.preco * 0.5))} Ouro (50% OFF!)\n` +
            `📝 ${hab.descricao}\n\n` +
            `⚡ Use: ${comandoUso}\n\n` +
            `🕛 Válido por 24 horas!`;

        let successCount = 0;
        let failCount = 0;

        for (const groupId of groupArray) {
            try {
                if (!groupId || !groupId.endsWith('@g.us')) continue;
                
                await safeSendMessage(sock, groupId, { text: notificationText });
                successCount++;
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (e) {
                failCount++;
                console.warn(`[DISCOUNT] Erro ao notificar grupo ${groupId}: ${e.message}`);
            }
        }

        console.log(`[DISCOUNT] Notificações enviadas: ${successCount} sucesso, ${failCount} falhas.`);
    } catch (e) {
        console.error(`[DISCOUNT] Erro ao notificar grupos: ${e.message}`);
    }
}


async function enviarMidiaComFallback(chatId, vP, gP, mId, caption, mentions = [], imgFallbackPath = null) {
    try {
        let mediaBuffer = null, isVideo = false;

        if (existsSync(vP)) { mediaBuffer = await fs.readFile(vP); isVideo = true; }
        else if (existsSync(gP)) { mediaBuffer = await fs.readFile(gP); isVideo = true; }
        else if (imgFallbackPath && existsSync(imgFallbackPath)) { mediaBuffer = await fs.readFile(imgFallbackPath); }

        const options = { caption: caption, mentions: mentions };

        if (mediaBuffer) {
            if (isVideo) {
                options.video = mediaBuffer;
                options.gifPlayback = true;
                options.mimetype = 'video/mp4';
            } else {
                options.image = mediaBuffer;
            }
            await safeSendMessage(sock, chatId, options);
        } else {
            console.warn(`!!! Mídia (mp4, gif) ${mId} não enc.: ${vP} ou ${gP}.`);
            options.text = `🎬 (Mídia ${mId} não enc.)\n\n${caption}`;
            await safeSendMessage(sock, chatId, options);
        }
    } catch (sE) {
        console.error(`!!! Erro enviar mídia ${mId}: ${sE.message}`);
        await safeSendMessage(sock, chatId, { text: `🎬 (Erro Mídia)\n\n${caption}`, mentions: mentions });
    }
}


function getDynamicPrice(item, itemId, user, type) {
    let finalPrice = item.preco;
    let discountMsg = "";


    if (type === 'habilidade' && settings.dailyDiscount?.id === itemId && Date.now() < settings.dailyDiscount.expires) {
        finalPrice = Math.floor(finalPrice * 0.5);
        discountMsg = " (50% Oferta do Dia!)";
        return { finalPrice, discountMsg }; 
    }


    const isGojo = user.cla_id === 'gojo';
    const isShinigami = user.cla_id === 'shinigami';

    if (isGojo) {
        if (type === 'loja' && item.categoria === 'jujutsu_kaisen') { 


        } else if (type === 'habilidade' && item.anime === 'Jujutsu Kaisen') {
            finalPrice = Math.floor(finalPrice * 0.5);
            discountMsg = " (50% Desconto JJK!)";
        }
    }

    if (isShinigami && type === 'habilidade' && item.anime === 'Bleach') {
        finalPrice = Math.floor(finalPrice * 0.5);
        discountMsg = " (50% Desconto Shinigami!)";
    }

    return { finalPrice, discountMsg };
}


function sortearCla(clasArray, sorteMultiplier = 1) {
    if (!Array.isArray(clasArray) || clasArray.length === 0) { console.error("Erro: array clãs inválido."); return null; }
    let pool = [];
    clasArray.forEach(c => { 
        let n = (typeof c.chance === 'number' && c.chance > 0) ? c.chance : (c.chance === 0 ? 0 : 1); 
        if (sorteMultiplier > 1 && c.chance <= 3) {
            n = Math.floor(n * sorteMultiplier);
        }
        for(let i=0; i<n; i++) pool.push(c); 
    });
    if (pool.length === 0) { console.error("Erro: Pool clãs vazio (talvez todos tenham chance 0?)."); return clasArray[0] || null; }
    return pool[Math.floor(Math.random()*pool.length)];
}

function findItemInLoja(itemId, returnFull = false) {
    if (!loja.categorias) return returnFull ? { item: null, catId: null } : null;
    const lId = itemId.toLowerCase();
    for (const cId in loja.categorias) { 
        const c = loja.categorias[cId]; 
        if (c?.itens) { 
            for (const k in c.itens) {
                if (k.toLowerCase() === lId) {
                    return returnFull ? { item: c.itens[k], catId: cId } : c.itens[k];
                }
            }
        }
    } 
    return returnFull ? { item: null, catId: null } : null;
}

function getBuffMultiplier(user, buffType) {
    if (!user?.cla_id) return 1.0; const cD = clas.find(c => c.id === user.cla_id);
    if (cD?.buff?.type === buffType && typeof cD.buff.multiplier === 'number') return cD.buff.multiplier; return 1.0;
}
function getClaRarities() {
    if (!Array.isArray(clas) || clas.length === 0) return { rarities: {}, total: 0 };
    let totalWeight = 0;
    clas.forEach(c => { 
        totalWeight += (typeof c.chance === 'number' && c.chance > 0) ? c.chance : (c.chance === 0 ? 0 : 1); 
    });

    if (totalWeight === 0) return { rarities: {}, total: 0 };

    const rarities = {};
    for (const claData of clas) {
        const claChanceWeight = (typeof claData.chance === 'number' && claData.chance > 0) ? claData.chance : (claData.chance === 0 ? 0 : 1);
        rarities[claData.id] = (claChanceWeight / totalWeight) * 100;
    }
    return { rarities, total: totalWeight };
}


function fmt(n) { const num = typeof n === 'number' ? n : 0; return new Intl.NumberFormat('pt-BR').format(Math.floor(num)); }
function timeLeft(tM) { const d=tM-Date.now(); if(d<=0)return'agora'; const s=Math.ceil(d/1000),m=Math.floor(s/60),rs=s%60,h=Math.floor(m/60),rm=m%60,D=Math.floor(h/24),rH=h%24; let p=[]; if(D>0)p.push(`${D}d`); if(rH>0)p.push(`${rH}h`); if(rm>0&&D===0)p.push(`${rm}m`); if(rs>0&&h===0&&D===0)p.push(`${rs}s`); return p.length>0?p.join(' '):'agora'; }
function parseAmount(t,max){ if(!t)return NaN; const l=t.trim().toLowerCase(); if(['all','tudo','max'].includes(l))return max; let m=1; if(l.endsWith('k'))m=1000; if(l.endsWith('m'))m=1000000; const n=parseFloat(l.replace(/[^0-9.]/g,''))*m; return isNaN(n)?NaN:Math.max(0,Math.floor(n)); }


async function skillTimerLoop(sockInstance) {
    if (!sockInstance) return;
    const now = Date.now();
    let timersDbChanged = false;
    let userDbChanged = false;
    let payoutDbChanged = false; 


    for (const chatId in timers) {
        const timer = timers[chatId];
        if (now >= timer.expires) {
            console.log(`[SKILL] Timer expirado ${timer.skillId} chat ${chatId}.`);

            const skill = (typeof habilidades === 'object' && habilidades) ? habilidades[timer.skillId] : null;
            const attacker = usuarios[timer.attackerId];


            delete timers[chatId];
            timersDbChanged = true;

            const getNum = (jid) => jid.split('@')[0];


            if (timer.skillId === 'zawarudo') {
                console.log(`[ZA WARUDO-REVERT] Revertendo efeitos em ${chatId}...`);
                try {
                    const promoted = timer.affectedPromoted || [];
                    const settings = timer.appliedSettings || [];


                    for (const pj of promoted) {
                        try {
                            await sockInstance.groupParticipantsUpdate(chatId, [pj], 'demote');
                            console.log(`[ZA WARUDO-REVERT] Demoted ${pj} em ${chatId}`);
                        } catch (e) {
                            console.warn(`[ZA WARUDO-REVERT] Falha ao demitir ${pj}: ${e.message}`);
                        }
                    }


                    if (settings.includes('announcement')) {
                        try {
                            await sockInstance.groupSettingUpdate(chatId, 'not_announcement');
                            console.log(`[ZA WARUDO-REVERT] Grupo ${chatId} reaberto (not_announcement).`);
                        } catch (e) {
                            console.warn(`[ZA WARUDO-REVERT] Falha ao reabrir grupo: ${e.message}`);
                        }
                    }
                    if (settings.includes('locked')) {
                        try {
                            await sockInstance.groupSettingUpdate(chatId, 'unlocked');
                            console.log(`[ZA WARUDO-REVERT] Grupo ${chatId} desbloqueado (unlocked).`);
                        } catch (e) {
                            console.warn(`[ZA WARUDO-REVERT] Falha ao unlock group: ${e.message}`);
                        }
                    }


                    try {
                        await safeSendMessage(sockInstance, chatId, {
                            text: `⏰ *ZA WARUDO!* acabou — o tempo voltou ao normal.`
                        });
                    } catch (e) {
                        console.warn(`[ZA WARUDO-REVERT] Falha ao enviar notificação de fim: ${e.message}`);
                    }
                } catch (e) {
                    console.error(`[ZA WARUDO-REVERT] Erro ao reverter efeitos: ${e.message}`);
                }
                continue; 
            }


            if (timer.affects_all_others) {
                if (!attacker || !skill) { console.warn(`[SKILL] Atac/skill Área nulo.`); continue; }

                let totalOuroRoubado = 0;
                const mencoes = [denormalizeJid(timer.attackerId)];
                const multiplier = skill.multiplier || 1.0;
                const resets_targets = skill.resets_targets || false;
                const is_unavoidable = timer.is_unavoidable || skill.is_unavoidable || false;

                const groupMembers = new Set();
                let groupMetadataSuccess = false;
                try {
                    const groupMeta = await safeGroupMetadata(sockInstance, timer.chatId);
                    if (groupMeta && groupMeta.participants) {
                        for (const participant of groupMeta.participants) {
                            const normalizedParticipantId = normalizeJid(participant.id);
                            if (normalizedParticipantId) {
                                groupMembers.add(normalizedParticipantId);
                            }
                        }
                        groupMetadataSuccess = true;
                    }
                } catch (e) {
                    console.warn(`[SKILL AREA] Erro ao obter membros do grupo ${timer.chatId}: ${e.message}`);
                }

                if (!groupMetadataSuccess) {
                    console.warn(`[SKILL AREA] Não foi possível obter membros do grupo ${timer.chatId}. Pulando execução da habilidade.`);
                    try {
                        await safeSendMessage(sockInstance, timer.chatId, { 
                            text: `⚠️ Erro: Não foi possível obter a lista de membros do grupo. A habilidade em área foi cancelada.` 
                        });
                    } catch (e) {}
                    continue;
                }

                for (const uId in usuarios) {
                    if (uId === timer.attackerId || (usuarios[uId].ouro || 0) <= 0) continue;
                    
                    if (!groupMembers.has(uId)) {
                        continue;
                    }

                    const target = usuarios[uId];
                    const ouroAlvo = target.ouro || 0;


                    if (timer.skillId === 'vazio_roxo' && target.cla_id === 'gojo') {
                        try { safeSendMessage(sockInstance, timer.chatId, { text: `♾️ ${target.nome} (Gojo) é imune ao Vazio Roxo!` }); } catch {}
                        continue;
                    }

                    if (skill.anime === 'Jujutsu Kaisen' && (target.buffs?.mahoraga_adapt || 0) > now) {
                        try { safeSendMessage(sockInstance, timer.chatId, { text: `☸️ ${target.nome} está adaptado! O ataque JJK foi anulado!` }); } catch {}
                        continue;
                    }

                    if (!is_unavoidable) {
                        const bVI = target.habilidades?.indexOf('blut_vene');
                        if (bVI !== -1 && bVI !== undefined) {
                            target.habilidades.splice(bVI, 1);
                            userDbChanged = true;
                            try { safeSendMessage(sockInstance, timer.chatId, { text: `🛡️ Blut Vene! ${target.nome} anulou o ataque em área!` }); } catch {}
                            continue;
                        }
                        if ((target.mugen_charges || 0) > 0) {
                            target.mugen_charges -= 1;
                            userDbChanged = true;
                            try { safeSendMessage(sockInstance, timer.chatId, { text: `♾️ Mugen! ${target.nome} anulou o ataque! (${target.mugen_charges} cargas restantes)` }); } catch {}
                            continue;
                        }
                        if (target.cla_id === 'hyuga' && Math.random() < (clas.find(c => c.id === 'hyuga')?.buff?.chance || 0.15)) {
                            try { safeSendMessage(sockInstance, timer.chatId, { text: `👁️ Byakugan! ${target.nome} desviou do ataque em área!` }); } catch {}
                            continue;
                        }
                        const iSI = target.habilidades?.indexOf('instinto_superior');
                        const cd_IS = target.cooldowns?.instinto_superior || 0;
                        if (iSI !== -1 && iSI !== undefined && now >= cd_IS) {
                            target.cooldowns.instinto_superior = now + (4 * 60 * 60 * 1000);
                            userDbChanged = true;
                            try { 
                                safeSendMessage(sockInstance, timer.chatId, { 
                                    text: `🌌 Instinto Superior! ${target.nome} desviou e anulou o ataque em área! (CD 4h)`,
                                    mentions: [denormalizeJid(uId)] 
                                }); 
                            } catch {}
                            continue;
                        }
                        const rT = target.habilidades?.indexOf('reacao_total');
                        const cd_RT = target.cooldowns?.reacao_total || 0;
                        if (rT !== -1 && rT !== undefined && now >= cd_RT) {
                            target.cooldowns.reacao_total = now + (4 * 60 * 60 * 1000);
                            userDbChanged = true;
                            try { 
                                const aNum = getNum(timer.attackerId);
                                safeSendMessage(sockInstance, timer.chatId, { 
                                    text: `⚔️ Reação Total! ${target.nome} refletiu o ataque em área de @${aNum}! (CD 4h)`,
                                    mentions: [denormalizeJid(timer.attackerId), denormalizeJid(uId)] 
                                }); 
                            } catch {}
                            continue;
                        }
                    }


                    let rouboIndividual = 0;
                    if (timer.skillId === 'bankai_senbonzakura') rouboIndividual = Math.floor(ouroAlvo * 0.20);
                    else if (timer.skillId === 'belzebu') rouboIndividual = Math.floor(ouroAlvo * 0.75);
                    else if (timer.skillId === 'respiracao_do_sol') rouboIndividual = Math.floor(ouroAlvo * 0.40);
                    else if (timer.skillId === 'estrondo') rouboIndividual = Math.floor(ouroAlvo * 0.50);
                    else if (timer.skillId === 'santuario_malevolente') rouboIndividual = Math.floor(ouroAlvo * 0.90);
                    else if (timer.skillId === 'excalibur') rouboIndividual = Math.floor(ouroAlvo * 0.60);
                    else if (timer.skillId === 'king_crimson') rouboIndividual = Math.floor(ouroAlvo * 0.35);
                    else if (timer.skillId === 'bankai_hyorinmaru') rouboIndividual = Math.floor(ouroAlvo * 0.40);
                    else if (['atomic', 'vazio_roxo', 'madoka', 'mugetsu'].includes(timer.skillId)) rouboIndividual = ouroAlvo;

                    target.ouro -= rouboIndividual;
                    totalOuroRoubado += rouboIndividual;
                    mencoes.push(denormalizeJid(uId));

                    if (resets_targets) {
                        try {
                            const claSorteado = sortearCla(clas) || { nome: "Humano Comum", id: "comum", buff: { description: "Nenhum." } };
                            let ouroInicial = 100, habilidadesIniciais = [];
                            if (claSorteado.buff) {
                                if (claSorteado.buff.type === 'gold_start') ouroInicial += claSorteado.buff.amount || 0;
                                if (claSorteado.buff.type === 'skill_start' && claSorteado.buff.skillId) habilidadesIniciais.push(claSorteado.buff.skillId);
                            }

                            console.log(`[MADOKA] Resetando usuário ${target.nome} (${uId}).`);
                            usuarios[uId] = {
                                nome: target.nome,
                                ouro: ouroInicial,
                                bank: 0,
                                cla: claSorteado.nome,
                                cla_id: claSorteado.id,
                                passivos: [],
                                habilidades: habilidadesIniciais,
                                cooldowns: {},
                                job: null,
                                lastKnownChatId: target.lastKnownChatId,
                                notificationChatId: target.notificationChatId 
                            };

                            if (claSorteado.id === 'gojo') {
                                usuarios[uId].mugen_charges = 1;
                                usuarios[uId].mugen_cooldown = Date.now();
                            }

                            if (payouts[uId]) {
                                delete payouts[uId];
                                payoutDbChanged = true; 
                            }
                            userDbChanged = true;

                        } catch (e) { console.error(`Erro ao resetar user ${uId}: ${e}`); }
                    }
                }

                attacker.ouro = (attacker.ouro || 0) + Math.round(totalOuroRoubado * multiplier);
                userDbChanged = true;

                try {
                    const aNum = getNum(timer.attackerId);
                    let msg = skill.msg_sucesso || 'Efeito aplicado.';
                    msg = msg.replace('{atacante}', aNum).replace('{ouro_roubado}', fmt(totalOuroRoubado));
                    let title = "💀 Tempo acabou! 💀";
                    if (['atomic', 'madoka', 'mugetsu', 'estrondo'].includes(timer.skillId)) title = "🌌 Realidade Alterada 🌌";
                    await safeSendMessage(sockInstance, timer.chatId, { text: `${title}\n\n${msg}`, mentions: mencoes });
                } catch (e) { console.warn(`Erro msg ${timer.skillId}:`, e.message); }
                continue;
            }


            else {
                const target = usuarios[timer.targetId];
                if (!attacker || !target || !skill) { 
                    console.warn(`[SKILL] Atacante (${!!attacker}), Alvo (${!!target}) ou Skill (${!!skill}) nulo(s) para o timer ${timer.skillId}.`); 
                    continue; 
                }

                const is_unavoidable = timer.is_unavoidable || skill.is_unavoidable || false;


                if (skill.anime === 'Jujutsu Kaisen' && (target.buffs?.mahoraga_adapt || 0) > now) {
                    try { safeSendMessage(sockInstance, timer.chatId, { text: `☸️ ${target.nome} está adaptado! O ataque JJK foi anulado!` }); } catch {}
                    continue;
                }

                if (!is_unavoidable) {

                    const bVI = target.habilidades?.indexOf('blut_vene');
                    if (bVI !== -1 && bVI !== undefined) {
                        target.habilidades.splice(bVI, 1);
                        userDbChanged = true;
                        try {
                            const aNum = getNum(timer.attackerId);
                            await safeSendMessage(sockInstance, timer.chatId, {
                                text: `🛡️ Blut Vene! ${target.nome} anulou @${aNum}!`,
                                mentions: [denormalizeJid(timer.attackerId), denormalizeJid(timer.targetId)],
                            });
                        } catch (e) {}
                        continue;
                    }

                    if ((target.mugen_charges || 0) > 0) {
                        target.mugen_charges -= 1;
                        userDbChanged = true;
                        try {
                            const aNum = getNum(timer.attackerId);
                            await safeSendMessage(sockInstance, timer.chatId, { 
                                text: `♾️ Mugen! O ataque de @${aNum} contra ${target.nome} foi anulado! (${target.mugen_charges} cargas restantes)`,
                                mentions: [denormalizeJid(timer.attackerId), denormalizeJid(timer.targetId)],
                            }); 
                        } catch {}
                        continue;
                    }

                    if (target.cla_id === 'hyuga' && Math.random() < (clas.find(c => c.id === 'hyuga')?.buff?.chance || 0.15)) {
                        try { await safeSendMessage(sockInstance, timer.chatId, { text: `👁️ Byakugan! ${target.nome} anulou!` }); } catch (e) {}
                        continue;
                    }

                    const iSI = target.habilidades?.indexOf('instinto_superior');
                    const cd_IS = target.cooldowns?.instinto_superior || 0;
                    if (iSI !== -1 && iSI !== undefined && now >= cd_IS) {

                        target.cooldowns.instinto_superior = now + (4 * 60 * 60 * 1000); 
                        userDbChanged = true;

                        try {
                            const aNum = getNum(timer.attackerId);
                            const tNum = getNum(timer.targetId);
                            await safeSendMessage(sockInstance, timer.chatId, {
                                text: `🌌 Instinto Superior! @${tNum} desviou e anulou o ataque de @${aNum}! (CD 4h)`,
                                mentions: [denormalizeJid(timer.attackerId), denormalizeJid(timer.targetId)],
                            });
                        } catch(e) {}
                        continue;
                    }
                    const rT = target.habilidades?.indexOf('reacao_total');
                    const cd_RT = target.cooldowns?.reacao_total || 0;
                    if (rT !== -1 && rT !== undefined && now >= cd_RT) {
                        target.cooldowns.reacao_total = now + (4 * 60 * 60 * 1000);
                        userDbChanged = true;
                        try {
                            const aNum = getNum(timer.attackerId);
                            const tNum = getNum(timer.targetId);
                            await safeSendMessage(sockInstance, timer.chatId, {
                                text: `⚔️ Reação Total! @${tNum} refletiu o ataque de @${aNum}! (CD 4h)`,
                                mentions: [denormalizeJid(timer.attackerId), denormalizeJid(timer.targetId)],
                            });
                        } catch(e) {}
                        continue;
                    }
                }


                let oR = 0; 
                const tO = target.ouro || 0;
                const aO = attacker.ouro || 0;
                const multiplier = skill.multiplier || 1.0;


                if (timer.skillId === 'deathnote') oR = tO;
                else if (timer.skillId === 'mahito') oR = Math.floor(tO * 0.30);
                else if (timer.skillId === 'geass') oR = Math.floor(tO * 0.50);
                else if (timer.skillId === 'gate_of_babylon') oR = Math.floor(tO * (Math.random() * 0.35 + 0.05)); 
                else if (timer.skillId === 'gomu_gomu_rocket') oR = Math.floor(tO * 0.15);
                else if (timer.skillId === 'mangekyou_inicial') oR = Math.floor(tO * 0.10);
                else if (timer.skillId === 'bola_de_ki') oR = Math.floor(tO * 0.08);
                else if (timer.skillId === 'punhos_divergentes') oR = Math.floor(tO * 0.10);
                else if (timer.skillId === 'tsubame_gaeshi') oR = Math.floor(tO * 0.25);
                else if (timer.skillId === 'kira_queen') oR = Math.floor(tO * 0.60);
                else if (timer.skillId === 'rasengan') oR = Math.floor(tO * 0.18);
                else if (timer.skillId === 'getsuga_tenshou') oR = Math.floor(tO * 0.22);
                else if (timer.skillId === 'kamehameha') oR = Math.floor(tO * 0.20);
                else if (timer.skillId === 'amaterasu') oR = Math.floor(tO * 0.45);
                else if (timer.skillId === 'domino') oR = Math.floor(tO * 0.50);
                else if (timer.skillId === 'akaza_compass') oR = Math.floor(tO * 0.30);
                else if (timer.skillId === 'gomu_gomu_storm') oR = Math.floor(tO * 0.28);
                else if (timer.skillId === 'kaikai') oR = Math.floor(tO * 0.24);
                else if (timer.skillId === 'santoryu') oR = Math.floor(tO * 0.12);
                else if (timer.skillId === 'soco_serio') oR = tO;


                target.ouro = tO - oR;
                attacker.ouro = aO + Math.round(oR * multiplier);
                userDbChanged = true;

                try {
                    const aNum = getNum(timer.attackerId);
                    const tNum = getNum(timer.targetId);
                    let msg = skill.msg_sucesso || `Efeito!`;
                    msg = msg.replace('{alvo}', tNum).replace('{atacante}', aNum).replace('{ouro_roubado}', fmt(oR));
                    await safeSendMessage(sockInstance, timer.chatId, {
                        text: `💀 Tempo acabou! 💀\n\n${msg}`,
                        mentions: [denormalizeJid(timer.attackerId), denormalizeJid(timer.targetId)],
                    });
                } catch (e) { console.warn(`Erro msg ${timer.skillId}:`, e.message); }
            }
        }
    }


    if (timersDbChanged) {
        await saveDB(TIMERS_DB, timers);
    }
    if (userDbChanged) {
        await saveDB(USUARIOS_DB, usuarios);
    }
    if (payoutDbChanged) { 
        await saveDB(PAYOUTS_DB, payouts);
    }
}