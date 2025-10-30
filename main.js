// main.js — Versão 4.0 (Reconexão, Persistência, Clãs) - PARTE 1/3
// BIBLIOTECA: @whiskeysockets/baileys
// OTIMIZAÇÃO: Persistência de timers (payouts.json, timers.json)
//
// --- ATUALIZAÇÕES v4.0 (Changelog Parcial) ---
// FEATURE (Item 3): Lógica de reconexão com backoff exponencial.
// FEATURE (Item 6): Loops de renda e skill agora usam DBs persistentes (timers.json, payouts.json).
// FEATURE (Item 8): Adicionado DB de settings.json (para toggles e descontos).
// FEATURE (Item 5): Adicionado loop de cooldown de clãs (Gojo, Sayajin).
// FEATURE (Item 7): Verificação de desconto diário no boot.
// FEATURE (Item 1/7): Roteador de mensagens atualizado para novas siglas e habilidades de clã.
// FEATURE (Item 7): Adicionado BOT_OWNER_JID para comandos de admin (.add @user).

const fs = require('fs').promises; // Async FS
const { existsSync, readFileSync: readFileSyncSync } = require('fs'); // Sync para checagem
const path = require('path');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    areJidsSameUser,
    jidNormalizedUser // <-- ADICIONE ESTA LINHA
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino'); // Logger do Baileys

// --- Logs Iniciais ---
console.log('[DEBUG] Script main.js (Baileys v4.0) iniciado.');

// --- CONFIGURAÇÃO ---
const PREFIX = '.';
// !!! IMPORTANTE: Coloque seu JID de dono aqui (ex: 55119..._@s.whatsapp.net)
const BOT_OWNER_JID = '5528981124442@s.whatsapp.net'; // (Item 7)

const DADOS_DIR = './dados';
const MIDIAS_DIR = './midias';
const AUTH_DIR = './auth_info_baileys'; // Pasta para sessão do Baileys

// DBs Principais
const USUARIOS_DB = path.join(DADOS_DIR, 'usuarios.json');
const LOJA_DB = path.join(DADOS_DIR, 'loja.json');
const HABILIDADES_DB = path.join(DADOS_DIR, 'habilidades.json');
const CLAS_DB = path.join(DADOS_DIR, 'clas.json');

// DBs de Persistência (Item 6, 7, 8)
const PAYOUTS_DB = path.join(DADOS_DIR, 'payouts.json'); // Persiste timers de renda passiva
const TIMERS_DB = path.join(DADOS_DIR, 'timers.json');   // Persiste timers de skills (ataques)
const SETTINGS_DB = path.join(DADOS_DIR, 'settings.json'); // Persiste toggles (.renda off) e desconto diário

// Configs de Loop
const PAYOUT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutos
const RENDA_LOOP_INTERVAL = 15000; // (Item 6) Verifica pagamentos pendentes a cada 15s
const SKILL_LOOP_INTERVAL = 1000;  // Verifica timers de skills a cada 1s
const CLAN_LOOP_INTERVAL = 60000;  // (Item 5) Verifica cooldowns de clãs (Gojo, Sayajin) a cada 1 min
const CUSTO_GIRAR_CLA = 1500;

// Configs de Reconexão (Item 3)
let retryCount = 0;
const MAX_RETRIES = 5; // Máximo de 5 tentativas
console.log('[DEBUG] Configurações v4.0 definidas.');

// --- BANCO DE DADOS (GLOBAL VARS) ---
let usuarios = {};
let lojas = {};
let habilidades = {};
let clas = [];
let payouts = {};   // (Item 6)
let timers = {};    // (Item 6)
let settings = { dailyDiscount: { id: null, expires: 0 } }; // (Item 7/8)
let sock; // Variável global para o socket do Baileys
console.log('[DEBUG] Variáveis DB globais inicializadas.');

// --- Funções de Normalização JID (COMPATIBILIDADE DB) ---
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
// --- Fim Funções JID ---

// --- Funções DB (com logs) - OTIMIZADO PARA ASYNC ---
async function loadDB(filePath) {
    // ... (Função loadDB original - inalterada)
    const isHabilidades = filePath.endsWith('habilidades.json');
    try {
        if (existsSync(filePath)) { // Checagem síncrona é ok
            const data = await fs.readFile(filePath, 'utf8'); // Leitura Async
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
                // Fallback para leitura síncrona se o parse async falhar (para debug de erro)
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
                // (Item 6) Fallback para DBs de persistência
                if ([PAYOUTS_DB, TIMERS_DB, SETTINGS_DB].includes(filePath)) return {}; 
                return {};
            }
        }
        if (isHabilidades) console.warn(`[loadDB] Arquivo ${filePath} não encontrado.`);
        if (filePath === CLAS_DB) {
            console.warn(`[loadDB] Arquivo ${filePath} não encontrado, retornando array vazio.`);
            return [];
        }
        // (Item 6) Não avisa se os DBs de persistência não existirem na primeira vez
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
    // ... (Função saveDB original - inalterada)
    try {
        const dir = path.dirname(filePath);
        if (!existsSync(dir)) {
            await fs.mkdir(dir, { recursive: true });
        }
        await fs.writeFile(filePath, JSON.stringify(data, null, 2)); // Escrita Async
    } catch (err) {
        console.error(`Erro ao salvar ${filePath}:`, err);
    }
}
console.log('[DEBUG] Funções loadDB e saveDB definidas (async).');

// --- CLIENTE WHATSAPP (BAILEYS) ---
// (Item 3) - Função `startBot` renomeada para `connectToWhatsApp` para suportar reconexão
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

    // Listener de Credenciais
    sock.ev.on('creds.update', saveCreds);

    // Listener de Conexão (Item 3 - Lógica de Reconexão)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("[DEBUG] Evento 'qr'. Escaneie:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('[DEBUG] Evento "open" (Ready).');
            console.log('Bot de RPG v4.0 online!');
            retryCount = 0; // (Item 3) Reseta contador de tentativas no sucesso

            try {
                if (!existsSync(DADOS_DIR)) await fs.mkdir(DADOS_DIR, { recursive: true });
                if (!existsSync(MIDIAS_DIR)) await fs.mkdir(MIDIAS_DIR, { recursive: true });
            } catch (e) { console.error("Erro ao criar pastas:", e); }

            // Carrega DBs (Principais)
            usuarios = await loadDB(USUARIOS_DB);
            loja = await loadDB(LOJA_DB);
            habilidades = await loadDB(HABILIDADES_DB);
            clas = await loadDB(CLAS_DB);
            
            // Carrega DBs (Persistência - Item 6, 7, 8)
            payouts = await loadDB(PAYOUTS_DB);
            timers = await loadDB(TIMERS_DB);
            settings = await loadDB(SETTINGS_DB);
            
            // Garante que settings exista
            if (!settings || typeof settings !== 'object') settings = {};
            if (!settings.dailyDiscount) settings.dailyDiscount = { id: null, expires: 0 };
            if (!settings.userToggles) settings.userToggles = {}; // Para .renda off

            if (!loja.categorias) console.warn('AVISO: loja.json vazio/inválido.');
            if (typeof habilidades !== 'object' || !habilidades || Object.keys(habilidades).length === 0)
                console.warn('AVISO: habilidades.json vazio/não carregado.');
            if (!Array.isArray(clas) || clas.length === 0)
                console.warn('AVISO: clas.json vazio/inválido.');

            // (Item 7) Verifica/Define o desconto diário no boot
            await checkDailyDiscount(true); // true = forçar verificação no boot

            // Verificação de Mídias Faltantes
            console.log('\n========== VERIFICAÇÃO DE MÍDIAS ==========');
            const missingMedias = [];
            
            // Verifica habilidades
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
            
            // Verifica itens da loja
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

            // Inicia Loops
            console.log('Iniciando loop renda (Poll: ' + (RENDA_LOOP_INTERVAL/1000) + 's)...');
            setInterval(() => passiveIncomeLoop(sock), RENDA_LOOP_INTERVAL); // Passa sock
            
            console.log('Iniciando loop skills (Poll: ' + (SKILL_LOOP_INTERVAL/1000) + 's)...');
            setInterval(() => skillTimerLoop(sock), SKILL_LOOP_INTERVAL); // Passa sock
            
            console.log('Iniciando loop clãs (Poll: ' + (CLAN_LOOP_INTERVAL/1000) + 's)...');
            setInterval(() => clanCooldownLoop(sock), CLAN_LOOP_INTERVAL); // (Item 5) Passa sock
                        
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.warn(`[RECONNECT] Conexão fechada: ${statusCode || lastDisconnect.error}. Reconectando: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                if (retryCount < MAX_RETRIES) {
                    // (Item 3) Backoff exponencial: 5s, 15s, 45s, 135s, 405s
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

    // Listener de Mensagens
    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.message || message.key.fromMe) return;

        const chatId = message.key.remoteJid;
        if (!chatId || !chatId.endsWith('@g.us')) {
            // Só grupos
            return sock.sendMessage(chatId, { text: 'Só grupos.' });
        }

        const rawAuthorId = message.key.participant || message.key.remoteJid;
        const authorId = normalizeJid(rawAuthorId); // Usa JID ...@c.us para o DB

        if (!authorId) return; // Não processar se não houver autor

        // --- Anulação (Lógica adaptada para DB Persistente - Item 6) ---
        const activeTimer = timers[chatId]; // Lê do DB global
        const body = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();

        if (activeTimer) {
            const msgAnular = activeTimer.msg_anular?.toLowerCase();
            const bodyLower = body.toLowerCase();
            const getNum = (jid) => denormalizeJid(jid).split('@')[0];

            if (message.key.participant === denormalizeJid(activeTimer.targetId) && msgAnular && bodyLower === msgAnular) {
                // Alvo anulou (Habilidade de Alvo Único)
                const tNum = getNum(activeTimer.targetId);
                const aNum = getNum(activeTimer.attackerId);
                await sock.sendMessage(chatId, {
                    text: `⚔️ @${tNum} anulou @${aNum}!`,
                    mentions: [denormalizeJid(activeTimer.targetId), denormalizeJid(activeTimer.attackerId)],
                });
                delete timers[chatId];
                await saveDB(TIMERS_DB, timers); // (Item 6) Persiste a anulação
            } else if (activeTimer.affects_all_others && msgAnular && bodyLower === msgAnular) {
                // Alguém anulou (Habilidade em Área)
                const anNum = rawAuthorId.split('@')[0];
                const aNum = getNum(activeTimer.attackerId);
                let anulaMsg = "";
                // ... (lógica de anulação customizada inalterada) ...
                if (activeTimer.skillId === 'belzebu') { anulaMsg = `☀️ @${anNum} usou sua fé! Hinata salvou o grupo e ninguém foi roubado!`; }
                else if (activeTimer.skillId === 'vazio_roxo') { anulaMsg = ` adaptou! @${anNum} invocou Mahoraga e anulou o Vazio Roxo!`; }
                else if (activeTimer.skillId === 'santuario_malevolente') { anulaMsg = `♾️ @${anNum} expandiu seu domínio! O Santuário de @${aNum} foi neutralizado!`; }
                else if (activeTimer.skillId === 'respiracao_do_sol') { anulaMsg = `🌙 @${anNum} usou a Respiração da Lua! A técnica de @${aNum} foi bloqueada!`; }
                else { anulaMsg = `🛡️ @${anNum} repeliu @${aNum}! Ataque em área anulado!`; }
                
                await sock.sendMessage(chatId, { text: anulaMsg, mentions: [rawAuthorId, denormalizeJid(activeTimer.attackerId)], });
                delete timers[chatId];
                await saveDB(TIMERS_DB, timers); // (Item 6) Persiste a anulação
            }
        }

        // --- Comandos ---
        if (!body.startsWith(PREFIX)) return;
        const args = body.slice(PREFIX.length).trim().split(/ +/),
            command = args.shift().toLowerCase();

        if (command !== 'cadastro' && !usuarios[authorId]) {
            return sock.sendMessage(chatId, { text: `Não cadastrado! Use *.cadastro NOME*` });
        }
        
        // Atualiza o lastKnownChatId (v3.4)
        if (command !== 'cadastro' && usuarios[authorId]) {
            usuarios[authorId].lastKnownChatId = chatId;
        }

        try {
            // (Item 1) Roteamento de Siglas (a lógica será tratada no handler)
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
                // Loja (Item 7 - .comprarhabilidade removido)
                case 'loja':
                // (Item 1) Pega o ID/Sigla da loja (ex: .loja aot ou .loja jjk)
                const lojaId = (args[0] || '').toLowerCase();
                if (!lojaId) {
                    // Se não houver argumentos, mostra o menu de categorias
                    await handleLoja(message, chatId);
                    break;
                }
                
                // Resolve sigla para ID canônico (ex: jjk -> jujutsu_kaisen)
                const resolvedLojaId = SIGLA_MAP_LOJA[lojaId] || lojaId;
                
                // Verifica se a categoria existe
                if (loja.categorias && loja.categorias[resolvedLojaId]) {
                    await handleLojaCategoria(message, resolvedLojaId, chatId);
                } else {
                    return sock.sendMessage(chatId, { text: `Loja *${lojaId}* não encontrada.` });
                }
                break;
                case 'comprar': await handleComprar(message, args, authorId, chatId); break;
                // Habilidades
                case 'habilidades':
                // (Item 5) Pega o ID/Sigla (ex: .habilidades jjk ou .habilidades gojo)
                const habArg = (args[0] || '').toLowerCase();
                if (!habArg) {
                    // Se não houver argumentos, mostra o menu de categorias de animes
                    await handleHabilidades(message, chatId);
                    break;
                }
                
                // Primeiro tenta resolver como sigla de anime
                const resolvedAnimeName = SIGLA_MAP_HABILIDADES[habArg];
                
                if (resolvedAnimeName) {
                    // É uma sigla válida de anime (ex: jjk -> jujutsu_kaisen)
                    // Passa o nome canônico normalizado, não a sigla
                    await handleHabilidadesCategoria(message, resolvedAnimeName.replace(/ /g, '_'), chatId);
                } else {
                    // Pode ser um nome de anime normalizado ou um clã
                    // Verifica se tem habilidades deste anime
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
                        // É um nome de anime válido
                        await handleHabilidadesCategoria(message, habArg, chatId);
                    } else {
                        // Tenta como clã
                        const claDef = clas.find(c => c.id === habArg || c.sigla === habArg);
                        if (claDef) {
                            await handleHabilidadesCla(message, authorId, chatId, claDef);
                        } else {
                            return sock.sendMessage(chatId, { text: `Categoria/Clã *${habArg}* não encontrado.` });
                        }
                    }
                }
                break;
                // case 'comprarhabilidade': // REMOVIDO (Item 7)
                case 'trade': await handleTrade(message, args, authorId, chatId); break;
                // Economia
                case 'banco': await handleBanco(message, authorId, chatId); break;
                case 'depositar': await handleDepositar(message, args, authorId, chatId); break;
                case 'sacar': await handleSacar(message, args, authorId, chatId); break;
                case 'pix': await handlePix(message, args, authorId, chatId); break;
                case 'carteira': await handleCarteira(message, authorId, chatId); break;
                // Ganhos
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
                // Clã
                case 'clas': await handleClas(message, authorId, chatId); break;
                case 'girarcla': await handleGirarCla(message, args, authorId, chatId); break;
                case 'listarclas': await handleListarClas(message, chatId); break;
                // Config (Item 8)
                case 'configurar': await handleConfigurar(message, chatId); break;
                case 'nick': await handleNick(message, args, authorId, chatId); break;
                case 'set': await handleSetNotifGrupo(message, authorId, chatId); break;
                case 'renda': await handleToggleRenda(message, authorId, chatId); break; // NOVO (Item 8)
                // Admin (Item 7)
                case 'add': await handleAddMoney(message, args, authorId, chatId); break;
                // Default (Habilidades)
                default:
                    if (typeof habilidades === 'object' && habilidades && habilidades[command]) {
                        const hab = habilidades[command];
                        
                        // (Item 5) Roteia para o handler correto
                        if (hab.is_clan_skill) {
                            // Se 'is_clan_skill: true' no habilidades.json
                            await handleUsarHabilidadeCla(message, command, authorId, chatId);
                        } else {
                            // Habilidades normais, consumíveis
                            await handleUsarHabilidade(message, command, authorId, chatId);
                        }
                    }
            }
        } catch (err) {
            console.error(`Erro comando "${command}":`, err);
            await sock.sendMessage(chatId, { text: `Erro ".${command}". 😵` });
        }
    });
    console.log("[DEBUG] Listener 'messages.upsert' (v4.0) definido.");
}

// --- INICIALIZAÇÃO ---
console.log('[DEBUG] Chamando connectToWhatsApp()...');
connectToWhatsApp(); // (Item 3) Chama a nova função de conexão
console.log('[DEBUG] connectToWhatsApp() chamado. Aguardando...');

// --- FUNÇÕES DE COMANDO (Adaptadas para Baileys) ---

// (authorId e chatId agora são passados diretamente)
// (saveDB agora é `await saveDB`)
// (Item 6) Funções de persistência (payouts, timers, settings) são salvas
// (Item 5) Lógica de Clã (Gojo, Beyond) adicionada
// (Item 1/7) Lógica de Siglas e Compra Unificada adicionada

// (Item 1) Mapa de Siglas para Roteamento
const ANIME_SIGLAS = {
    'jujutsu kaisen': 'jjk',
    'one piece': 'op',
    'attack on titan': 'aot',
    'dragon ball': 'dbz',
    'demon slayer': 'ds',
    'blue lock': 'bl',
    'naruto': 'naruto', // Exemplo se a sigla for o nome
    'bleach': 'bleach',
    'death note': 'dn',
    'code geass': 'geass',
    'fate': 'fate',
    'jojo\'s bizarre adventure': 'jojo',
    'eminence in shadow': 'atomic',
    'tensei slime': 'slime',
    'madoka magica': 'madoka',
    'one punch man': 'opm'
};

const SIGLA_MAP_HABILIDADES = Object.fromEntries(
    Object.entries(ANIME_SIGLAS).map(([k, v]) => [v, k.toLowerCase().replace(/[^a-z0-9]/g, '_')])
);

// Siglas para as lojas (categorias)
const SIGLA_MAP_LOJA = {
    'jjk': 'jujutsu_kaisen',
    'op': 'one_piece',
    'aot': 'attack_on_titan',
    'dbz': 'dragon_ball',
    'ds': 'demon_slayer',
    'bl': 'blue_lock',
    'naruto': 'naruto'
};

/**
 * Retorna a data atual no fuso-horário de Brasília (America/Sao_Paulo)
 * no formato 'YYYY-MM-DD', que é seguro para comparação.
 * Nanno que criou.
 */ 
function getDateInBrasilia() {
    const options = {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    };
    // Usar 'en-CA' força o formato YYYY-MM-DD
    return new Date().toLocaleDateString('en-CA', options);
}

async function handleCadastro(message, args, authorId, chatId) {
    if (usuarios[authorId]) return sock.sendMessage(chatId, { text: 'Você já está cadastrado!' });
    const nome = args.join(' ');
    if (!nome) return sock.sendMessage(chatId, { text: 'Precisa me dizer seu nome! Use: *.cadastro SEU-NOME*' });
    
    const claSorteado = sortearCla(clas); // Helper (Parte 3)
    if (!claSorteado) return sock.sendMessage(chatId, { text: 'Erro no cadastro: Não foi possível sortear um clã (DB de clãs vazio?).' });
    
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

    // --- LÓGICA CLÃ GOJO (Item 5) ---
    if (claSorteado.id === 'gojo') {
        usuarios[authorId].mugen_charges = 1; // Apenas 1 carga
        usuarios[authorId].mugen_cooldown = Date.now(); // Define o timer inicial (para recarga)
    }
    
    await saveDB(USUARIOS_DB, usuarios);
    
    const authorNumber = authorId.split('@')[0]; // Pega o número do JID
    const replyText = `🎉 Bem-vindo ao RPG, @${authorNumber}!\n\nNome: *${nome}*\nClã: *${claSorteado.nome}*\nBuff: ${claSorteado.buff?.description || 'Nenhum.'}\n\nComeça com *${fmt(ouroInicial)} Ouro*.\nUse *.menu* para comandos.`;
    
    await sock.sendMessage(chatId, {
        text: replyText,
        mentions: [denormalizeJid(authorId)], // Envia JID denormalizado
    });
}

async function handleMenu(message, authorId, chatId) {
    const user = usuarios[authorId];
    const authorNumber = authorId.split('@')[0];
    const top = '╭ೋ⚘ೋ•═══════════╗', mid = '⚘', sep = '════════ •『 ✨ 』• ════════', bot = '╚═══════════•ೋ⚘ೋ╯', icon = '🔹';
    
    let menuText = `${top}\n${mid} *Perfil de @${authorNumber}*\n${mid}\n${mid} *Nome:* ${user.nome}\n${mid} *Clã:* ${user.cla}\n`;
    
    // --- LÓGICA CLÃ GOJO (Item 5) ---
    if (user.cla_id === 'gojo') {
        const charges = user.mugen_charges || 0;
        if (charges > 0) {
            menuText += `${mid} *Mugen (Cargas):* ${charges} ♾️\n`;
        } else {
            const cd = user.mugen_cooldown || 0;
            const tLeft = timeLeft(cd); // Helper (Parte 3)
            menuText += `${mid} *Mugen (Cargas):* 0 ♾️\n${mid} *Recarregando:* ${tLeft}\n`;
        }
    }
    
    // --- CORREÇÃO DO MENU (Bug 6) ---
    menuText += `${mid} *Ouro:* ${fmt(user.ouro || 0)}💰\n${mid} *Banco:* ${fmt(user.bank || 0)}🏦\n${mid} ${sep}\n${mid} *Comandos Principais*\n${mid}   ${icon} *.loja*\n${mid}   ${icon} *.habilidades*\n${mid}   ${icon} *.menugold*\n${mid}   ${icon} *.clas*\n`;
    // Linha .carteira removida daqui
    menuText += `${mid}   ${icon} *.configurar*\n${mid} ${sep}\n${mid} *Posses*\n${mid} *Renda (${user.passivos?.length || 0}):*\n`;
    // --- FIM DA CORREÇÃO ---

    if (!user.passivos?.length) menuText += `${mid}   ${icon} _Nenhum item._\n`;
    else user.passivos.forEach(p => (menuText += `${mid}   ${icon} ${p.nome || p.id}\n`));
    
    menuText += `${mid}\n${mid} *Habilidades (${user.habilidades?.length || 0}):*\n`;
    if (!user.habilidades?.length) menuText += `${mid}   ${icon} _Nenhuma._\n`;
    else {
        user.habilidades.forEach(hId => {
            const d = (typeof habilidades === 'object' && habilidades) ? habilidades[hId] : null;
            if (d) {
                let u = `(.${hId})`;
                if (d.uso === 'Passivo (ativa automaticamente)') u = '(P)';
                else if (d.requires_no_target === false) u = `(.${hId} @alvo)`;
                
                // (Item 5) Mostra Cooldown de Skills de Clã
                let cdMsg = "";
                if (d.is_clan_skill) {
                    const cd = user.cooldowns?.[hId] || 0;
                    if (cd > Date.now()) {
                        cdMsg = ` (${timeLeft(cd)})`; // Helper (Parte 3)
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
            await sock.sendMessage(chatId, options);
        } else {
            console.warn(`[handleMenu] Nenhuma mídia (mp4, gif, jpg) enc. Usando fallback URL.`);
            await sock.sendMessage(chatId, {
                image: { url: 'https://img.odcdn.com.br/wp-content/uploads/2022/07/anya.jpg' },
                caption: menuText,
                mentions: [denormalizeJid(authorId)],
            });
        }
    } catch (menuError) {
        console.error(`!!! Erro enviar menu ${authorId}: ${menuError.message}`);
        await sock.sendMessage(chatId, { text: `⚠️ Erro mídia menu.\n\n${menuText}`, mentions: [denormalizeJid(authorId)] });
    }
}

async function handleLoja(message, chatId) {
    const top = '╭ೋ🛒ೋ•═══════════╗', mid = '🛒', sep = '═══════ •『 Anime 』• ═══════', bot = '╚═══════════•ೋ🛒ೋ╯', icon = '🔹';
    let txt = `${top}\n${mid} *Loja Renda Passiva*\n${mid}\n`;
    if (!loja.categorias || Object.keys(loja.categorias).length === 0) {
        txt += `${mid} Loja vazia. 😥\n${bot}`;
        return sock.sendMessage(chatId, { text: txt });
    }
    txt += `${mid} Escolha uma categoria:\n${mid} ${sep}\n`;
    for (const cId in loja.categorias) {
        const cat = loja.categorias[cId];
        txt += `${mid} ${icon} *${cat.nome_categoria}*\n${mid}    Cmd: \`${PREFIX}loja_${cId}\``;
        // (Item 1) Adiciona Sigla
        if (cat.sigla) {
            txt += ` (ou \`${PREFIX}loja_${cat.sigla}\`)`;
        }
        txt += `\n`;
    }
    txt += `${bot}`;
    await sock.sendMessage(chatId, { text: txt });
}

async function handleLojaCategoria(message, catId, chatId) {
    // (Item 1) Roteamento por Sigla
    let cat = loja.categorias?.[catId];
    if (!cat) {
        const resolvedId = SIGLA_MAP_LOJA[catId];
        if (resolvedId) cat = loja.categorias[resolvedId];
    }
    
    if (!cat) return sock.sendMessage(chatId, { text: `Categoria "${catId}" não enc. 😕` });
    
    const top = `╭ೋ🛒ೋ•═════ ${cat.nome_categoria} ═════╗`, mid = '🛒', bot = '╚══════════════•ೋ🛒ೋ╯', icon = '✨';
    // (Item 7) Comando de compra unificado
    let txt = `${top}\n${mid} Use \`${PREFIX}comprar <id>\`\n${mid}\n`;
    
    if (!cat.itens || Object.keys(cat.itens).length === 0) txt += `${mid} _Vazio._\n`;
    else {
        for (const itemId in cat.itens) {
            const i = cat.itens[itemId];
            txt += `${mid} ${icon} *${i.nome}*\n${mid}    ID: \`${itemId}\`\n${mid}    Preço: ${fmt(i.preco)}\n${mid}    Renda: ${fmt(i.renda)}/${i.cooldown_min}min\n${mid}    Info: ${i.descricao}\n${mid}\n`;
        }
    }
    txt += `${bot}`;
    await sock.sendMessage(chatId, { text: txt });
}

// --- (Item 7) COMANDO DE COMPRA UNIFICADO ---
async function handleComprar(message, args, authorId, chatId) {
    const itemId = args[0]?.toLowerCase();
    if (!itemId) return sock.sendMessage(chatId, { text: `ID do item/habilidade? Ex: *.comprar itoshirin_gol* ou *.comprar deathnote*` }, { quoted: message });

    // Tenta encontrar na Loja
    const { item: lojaItem, catId } = findItemInLoja(itemId, true); // Helper (Parte 3)
    
    // Tenta encontrar em Habilidades
    const habId = Object.keys(habilidades).find(k => k.toLowerCase() === itemId);
    const habItem = habId ? habilidades[habId] : null;

    if (lojaItem) {
        // Encontrou na Loja (Renda Passiva)
        await handleCompraLojaItem(message, args, authorId, chatId, lojaItem, catId, itemId);
    } else if (habItem && habItem.preco > 0) {
        // Encontrou em Habilidades (e é comprável)
        await handleCompraHabilidade(message, args, authorId, chatId, habItem, habId);
    } else if (habItem && habItem.preco === 0) {
        // Encontrou em Habilidades (mas não é comprável)
        return sock.sendMessage(chatId, { text: `🚫 A habilidade *${habItem.nome}* não pode ser comprada (é uma skill de clã ou bônus).` }, { quoted: message });
    } else {
        // Não encontrou em lugar nenhum
        return sock.sendMessage(chatId, { text: `Item/Habilidade *${itemId}* não encontrado! 😕 Verifique na *.loja* ou *.habilidades*.` }, { quoted: message });
    }
}

// --- (Item 7) Helper para compra de Renda Passiva ---
async function handleCompraLojaItem(message, args, authorId, chatId, item, catId, originalItemId) {
    const user = usuarios[authorId];
    user.passivos = user.passivos || [];

    const jaPossui = user.passivos.some(p => p.id.toLowerCase() === originalItemId);
    if (jaPossui) {
        return sock.sendMessage(chatId, { text: `🚫 Você já possui o item *${item.nome}*! Não é permitido comprar itens de renda repetidos.` }, { quoted: message });
    }
    
    // (Item 6) Desconto Gojo / Shinigami (em Loja)
    const { finalPrice, discountMsg } = getDynamicPrice(item, catId, user, 'loja'); // Helper (Parte 3)

    if ((user.ouro || 0) < finalPrice) {
        return sock.sendMessage(chatId, { text: `Ouro insuficiente! 😥\nPreço: ${fmt(finalPrice)}${discountMsg}\nSeu: ${fmt(user.ouro || 0)}` }, { quoted: message });
    }
    
    user.ouro -= finalPrice;
    
    const realItemId = Object.keys(loja.categorias[catId].itens).find(k => k.toLowerCase() === originalItemId) || originalItemId;
        
    // (Item 6) Adiciona ao DB de Payouts persistente
    const nextPayoutTime = Date.now() + item.cooldown_min * 60000;
    user.passivos.push({ id: realItemId, nome: item.nome }); // DB do usuário só rastreia posse
    
    payouts[authorId] = payouts[authorId] || {}; // DB de payouts rastreia timers
    payouts[authorId][realItemId] = nextPayoutTime;
    
    await saveDB(USUARIOS_DB, usuarios);
    await saveDB(PAYOUTS_DB, payouts);
    
    await sock.sendMessage(chatId, { text: `💸 Comprou *${item.nome}* por ${fmt(finalPrice)} Ouro${discountMsg}.\nRende em ${item.cooldown_min} min.` }, { quoted: message });
}

// --- (Item 7) Helper para compra de Habilidade ---
async function handleCompraHabilidade(message, args, authorId, chatId, hab, originalHabId) {
    const user = usuarios[authorId];
    user.cooldowns = user.cooldowns || {};
    user.habilidades = user.habilidades || [];
    const n = Date.now();

    // (Item 6) Desconto (Gojo, Shinigami, Diário)
    const { finalPrice, discountMsg } = getDynamicPrice(hab, originalHabId, user, 'habilidade'); // Helper (Parte 3)

    // Cooldown para skills caras
    if (finalPrice > 49000) {
        const C = 24 * 60 * 60 * 1000; // 24 horas
        const c = user.cooldowns.buy_expensive_skill || 0;
        if (n < c) {
            return sock.sendMessage(chatId, { text: `⏳ Você só pode comprar habilidades caras (+49k) novamente em ${timeLeft(c)}.` }, { quoted: message });
        }
        user.cooldowns.buy_expensive_skill = n + C; // Aplica o cooldown
    }

    if ((user.ouro || 0) < finalPrice) {
        if (finalPrice > 49000) delete user.cooldowns.buy_expensive_skill; // Reverte CD se falhar
        return sock.sendMessage(chatId, { text: `Ouro insuficiente! 😥\nPreço: ${fmt(finalPrice)}${discountMsg}\nSeu: ${fmt(user.ouro || 0)}` }, { quoted: message });
    }

    // (Item 7) Verifica se já possui
    if (user.habilidades.includes(originalHabId)) {
        if (finalPrice > 49000) delete user.cooldowns.buy_expensive_skill; // Reverte CD
         return sock.sendMessage(chatId, { text: `🚫 Você já possui a habilidade *${hab.nome}*!` }, { quoted: message });
    }
    
    user.ouro -= finalPrice;
    user.habilidades.push(originalHabId);
    await saveDB(USUARIOS_DB, usuarios);
    
    await sock.sendMessage(chatId, { text: `🔥 Comprou *${hab.nome}* por ${fmt(finalPrice)} Ouro${discountMsg}.\nUse ${hab.uso}!` }, { quoted: message });
}

async function handleHabilidades(message, chatId) {
    const top = '╭ೋ💥ೋ•═══════════╗', mid = '💥', sep = '═══════ •『 Anime 』• ═══════', bot = '╚═══════════•ೋ💥ೋ╯', icon = '🔹';
    let txt = `${top}\n${mid} *Loja Habilidades (PvP)*\n${mid}\n`;
    
    if (typeof habilidades !== 'object' || !habilidades || Object.keys(habilidades).length === 0) {
        txt += `${mid} Habilidades vazias/não carregadas. 😥\n${bot}`;
        return sock.sendMessage(chatId, { text: txt });
    }
    
    const cats = {};
    let hasB = false;
    for (const hId in habilidades) {
        const h = habilidades[hId];
        if (h.preco === 0) continue; // Não mostra habilidades de clã/gratuitas
        hasB = true;
        const anime = h.anime || 'Outros';
        const aK = anime.toLowerCase().replace(/[^a-z0-9]/g, '_');
        if (!cats[aK]) cats[aK] = { nome_categoria: anime };
    }
    
    if (!hasB) {
        txt += `${mid} Nenhuma comprável. 😥\n${bot}`;
        return sock.sendMessage(chatId, { text: txt });
    }
    
    txt += `${mid} Escolha uma categoria:\n${mid} ${sep}\n`;
    for (const catId in cats) {
        txt += `${mid} ${icon} *${cats[catId].nome_categoria}*\n${mid}    Cmd: \`${PREFIX}habilidades_${catId}\``;
        // (Item 1) Adiciona Sigla
        const sigla = ANIME_SIGLAS[cats[catId].nome_categoria.toLowerCase()];
        if (sigla) {
            txt += ` (ou \`${PREFIX}habilidades_${sigla}\`)`;
        }
        txt += `\n`;
    }
    txt += `${bot}`;
    await sock.sendMessage(chatId, { text: txt });
}

async function handleHabilidadesCategoria(message, catId, chatId) {
    // (Item 6) Precisa do authorId para descontos dinâmicos
    const authorId = normalizeJid(message.key.participant || message.key.remoteJid);
    if (!authorId) return; // Segurança
    const user = usuarios[authorId];
    
    // (Item 1) Roteamento por Sigla
    let resolvedCatName = (SIGLA_MAP_HABILIDADES[catId] || catId).replace(/_/g, ' ');

    let nomeCat = 'Desconhecida', habs = [];
    if (typeof habilidades === 'object' && habilidades) {
        for (const hId in habilidades) {
            const h = habilidades[hId];
            if (h.preco === 0) continue;
            const animeName = (h.anime || 'Outros').toLowerCase();
            if (animeName.replace(/[^a-z0-9]/g, '_') === resolvedCatName || animeName === resolvedCatName) {
                nomeCat = h.anime || 'Outros';
                habs.push(hId);
            }
        }
    }
    
    if (habs.length === 0) return sock.sendMessage(chatId, { text: `Nenhuma comprável em "${catId}" ou erro. 😕` });
    
    const top = `╭ೋ💥ೋ•═════ Habilidades ${nomeCat} ═════╗`, mid = '💥', bot = '╚══════════════•ೋ💥ೋ╯', icon = '🔥';
    // (Item 7) Comando de compra unificado
    let txt = `${top}\n${mid} Use \`${PREFIX}comprar <id>\`\n${mid}\n`;
    
    // (Item 7) Desconto Diário
    if (settings.dailyDiscount?.id) {
        const d = settings.dailyDiscount;
        const h = habilidades[d.id];
        if (h) {
            txt += `🎁 *OFERTA DO DIA (50% OFF)*\n${mid} ID: \`${d.id}\` (${h.nome})\n${mid} Expira em: ${timeLeft(d.expires)}\n${mid}\n`;
        }
    }

    for (const hId of habs) {
        const h = habilidades[hId];
        // (Item 6) Pega preço dinâmico
        const { finalPrice, discountMsg } = getDynamicPrice(h, hId, user, 'habilidade'); // Helper (Parte 3)
        
        txt += `${mid} ${icon} *${h.nome}*\n${mid}    ID: \`${hId}\`\n${mid}    Preço: ${fmt(finalPrice)}${discountMsg}\n${mid}    Uso: ${h.uso}\n${mid}    Info: ${h.descricao}\n${mid}\n`;
    }
    txt += `${bot}`;
    await sock.sendMessage(chatId, { text: txt });
}

async function handleTrade(message, args, authorId, chatId) {
    // ... (Função handleTrade original - inalterada) ...
    const user = usuarios[authorId];
    const habId = args[0]?.toLowerCase();
    
    if (!habId) {
        return sock.sendMessage(chatId, { text: `Qual habilidade? Use: *.trade <id_habilidade> @alvo*` }, { quoted: message });
    }

    let rawTargetJid = null;
    let tId = null;
    let targetNumber = null;
    
    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentionedJids.length === 0) {
        return sock.sendMessage(chatId, { text: `Marque o usuário para quem quer transferir! Use: *.trade ${habId} @alvo*` }, { quoted: message });
    }
    
    rawTargetJid = mentionedJids[0];
    tId = normalizeJid(rawTargetJid);
    targetNumber = rawTargetJid.split('@')[0];
    
    const targetUser = usuarios[tId];
    if (!targetUser) return sock.sendMessage(chatId, { text: 'Alvo não cadastrado.' }, { quoted: message });
    if (tId === authorId) return sock.sendMessage(chatId, { text: 'Não pode transferir para si mesmo!' }, { quoted: message });

    const habIndex = user.habilidades?.findIndex(h => h.toLowerCase() === habId);
    if (habIndex === -1 || habIndex === undefined) {
        return sock.sendMessage(chatId, { text: `Você não possui a habilidade *${habId}*!` }, { quoted: message });
    }
    
    const originalHabId = user.habilidades[habIndex];
    const habData = (typeof habilidades === 'object' && habilidades) ? habilidades[originalHabId] : null;

    if (!habData || habData.preco === 0) {
        return sock.sendMessage(chatId, { text: `A habilidade *${habData?.nome || habId}* é intransferível (provavelmente é uma skill de clã).` }, { quoted: message });
    }
    
    // (Item 7) Verifica se o alvo já possui
    if (targetUser.habilidades?.includes(originalHabId)) {
        return sock.sendMessage(chatId, { text: `🚫 @${targetNumber} já possui a habilidade *${habData.nome}*!`, mentions: [denormalizeJid(tId)] }, { quoted: message });
    }

    const [tradedSkill] = user.habilidades.splice(habIndex, 1);
    targetUser.habilidades = targetUser.habilidades || [];
    targetUser.habilidades.push(tradedSkill);
    
    await saveDB(USUARIOS_DB, usuarios);

    const authorNumber = authorId.split('@')[0];
    const replyText = `⚡ @${authorNumber} confiou seu poder lendário (*${habData.nome}*) para @${targetNumber}! Que o destino os observe! ⚡`;
    
    await sock.sendMessage(chatId, {
        text: replyText,
        mentions: [denormalizeJid(authorId), denormalizeJid(tId)],
    });
}


// --- FUNÇÕES DE CLÃ (Adaptadas) ---
async function handleClas(message, authorId, chatId) {
    const user = usuarios[authorId];
    const claData = clas.find(c => c.id === user.cla_id);
    if (!claData) return sock.sendMessage(chatId, { text: 'Erro: Não foi possível encontrar dados do seu clã.' });

    const { rarities, total } = getClaRarities(); // Helper (Parte 3)
    if (total === 0) return sock.sendMessage(chatId, { text: 'Erro: Clãs não configurados ou com chance 0.' });

    const percentage = rarities[user.cla_id] || 0;
    const authorNumber = authorId.split('@')[0];

    const top = '╭ೋ⛩️ೋ•═══════════╗', mid = '⛩️', bot = '╚═══════════•ೋ⛩️ೋ╯';
    let txt = `${top}\n${mid} *Clã de @${authorNumber}*\n${mid}\n`;
    txt += `${mid} *Nome:* ${claData.nome}\n`;
    txt += `${mid} *Buff:* ${claData.buff?.description || 'Nenhum.'}\n`;
    txt += `${mid} *Raridade:* ${percentage.toFixed(2)}%\n`;

    // --- LÓGICA CLÃ GOJO (Item 5) ---
    if (user.cla_id === 'gojo') {
        const charges = user.mugen_charges || 0;
        if (charges > 0) {
            txt += `${mid} *Mugen (Cargas):* ${charges} ♾️\n`;
        } else {
            const cd = user.mugen_cooldown || 0;
            const tLeft = timeLeft(cd); // Helper (Parte 3)
            txt += `${mid} *Mugen (Cargas):* 0 ♾️ (Recarrega em ${tLeft})\n`;
        }
    }
    
    txt += `${mid}\n${mid} Use *.listarclas* para ver todos.\n`;
    txt += `${mid} Use *.girarcla* para trocar (Custo: ${fmt(CUSTO_GIRAR_CLA)} Ouro).\n`;
    txt += `${bot}`;

    await sock.sendMessage(chatId, {
        text: txt,
        mentions: [denormalizeJid(authorId)],
    });
}

async function handleGirarCla(message, args, authorId, chatId) {
    const user = usuarios[authorId];
    if ((user.ouro || 0) < CUSTO_GIRAR_CLA) {
        return sock.sendMessage(chatId, { text: `Ouro insuficiente! 😥\nCusta: ${fmt(CUSTO_GIRAR_CLA)}\nSeu: ${fmt(user.ouro || 0)}` });
    }

    user.ouro -= CUSTO_GIRAR_CLA;

    // (Item 5) Não permitir clã duplicado
    const claAtualId = user.cla_id;
    const clasDisponiveis = clas.filter(c => c.id !== claAtualId);
    const claSorteado = sortearCla(clasDisponiveis); // Helper (Parte 3)

    if (!claSorteado) {
        user.ouro += CUSTO_GIRAR_CLA; // Reembolsa
        await saveDB(USUARIOS_DB, usuarios);
        return sock.sendMessage(chatId, { text: 'Erro ao girar: Não foi possível sortear um clã (DB de clãs vazio ou só existe o seu?). Ouro devolvido.' });
    }
    
    // --- LÓGICA DE RESET DE CLÃ (Item 5 - Generalizada) ---
    const oldClaData = clas.find(c => c.id === claAtualId);
    
    // Remove buffs antigos
    if (oldClaData?.buff?.type === 'skill_start' && oldClaData.buff.skillId) {
        const skillToRemove = oldClaData.buff.skillId;
        const skillIndex = user.habilidades?.indexOf(skillToRemove);
        if (skillIndex > -1) {
            user.habilidades.splice(skillIndex, 1);
            console.log(`[GirarCla] Removida skill antiga ${skillToRemove} de ${authorId}`);
        }
    }
    if (claAtualId === 'gojo') {
        delete user.mugen_charges;
        delete user.mugen_cooldown;
    }

    // Adiciona buffs novos
    if (claSorteado.buff?.type === 'skill_start' && claSorteado.buff.skillId) {
        user.habilidades = user.habilidades || [];
        if (!user.habilidades.includes(claSorteado.buff.skillId)) {
            user.habilidades.push(claSorteado.buff.skillId);
        }
    }
    if (claSorteado.id === 'gojo') {
        user.mugen_charges = 1; // (Item 5) Começa com 1 carga
        user.mugen_cooldown = Date.now(); // Inicia timer de recarga
    }
    // --- Fim Lógica Reset Clã ---

    const claAnterior = user.cla;
    user.cla = claSorteado.nome;
    user.cla_id = claSorteado.id;

    await saveDB(USUARIOS_DB, usuarios);

    const authorNumber = authorId.split('@')[0];
    const replyText = `🔄 @${authorNumber} gastou ${fmt(CUSTO_GIRAR_CLA)} Ouro!\n\nClã Antigo: *${claAnterior}*\nNovo Clã: *${claSorteado.nome}*\n\nBuff: ${claSorteado.buff?.description || 'Nenhum.'}`;
    
    await sock.sendMessage(chatId, {
        text: replyText,
        mentions: [denormalizeJid(authorId)],
    });
}

async function handleListarClas(message, chatId) {
    const { rarities, total } = getClaRarities(); // Helper (Parte 3)
    if (total === 0) return sock.sendMessage(chatId, { text: 'Nenhum clã configurado ou todos têm chance 0.' });

    const top = '╭ೋ⛩️ೋ•═══════════╗', mid = '⛩️', bot = '╚═══════════•ೋ⛩️ೋ╯', icon = '🔹';
    let txt = `${top}\n${mid} *Lista de Clãs*\n${mid}\n`;

    const clasOrdenados = [...clas].sort((a, b) => {
        const rarA = rarities[a.id] || 0;
        const rarB = rarities[b.id] || 0;
        return rarA - rarB; // Ordena do mais raro (menor %) para o mais comum
    });

    for (const claData of clasOrdenados) {
        const percentage = rarities[claData.id] || 0;
        if (percentage === 0) continue; // Não lista clãs com chance 0
        txt += `${mid} ${icon} *${claData.nome}*\n`;
        txt += `${mid}    Buff: ${claData.buff?.description || 'Nenhum.'}\n`;
        txt += `${mid}    Raridade: ${percentage.toFixed(2)}%\n`;
    }
    txt += `${bot}`;
    await sock.sendMessage(chatId, { text: txt });
}

// --- (Item 8) NOVO COMANDO ---
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
    // Linha .trade removida daqui
    txt += `${mid} ${icon} *.renda*\n`;
    txt += `${mid}    (Liga/Desliga as *notificações* de renda passiva. Ouro ainda é ganho.)\n`;
    txt += `${mid}    (Estado Atual: *${rendaNotifState}*)\n`;
    txt += `${bot}`;
    
    await sock.sendMessage(chatId, { text: txt });
}

async function handleNick(message, args, authorId, chatId) {
    // ... (Função handleNick original - inalterada) ...
    const user = usuarios[authorId];
    user.cooldowns = user.cooldowns || {};
    
    const NICK_COOLDOWN = 24 * 60 * 60 * 1000; // 1 dia
    const c = user.cooldowns.nick || 0;
    const n = Date.now();
    if (n < c) {
        return sock.sendMessage(chatId, { text: `⏳ Você só pode mudar seu nick novamente em ${timeLeft(c)}.` }, { quoted: message });
    }

    const novoNome = args.join(' ');
    if (!novoNome) {
        return sock.sendMessage(chatId, { text: 'Qual nome? Use: *.nick <novo-nome>*' }, { quoted: message });
    }
    
    const nomeAntigo = user.nome;
    user.nome = novoNome;
    user.cooldowns.nick = n + NICK_COOLDOWN;
    
    await saveDB(USUARIOS_DB, usuarios);
    
    await sock.sendMessage(chatId, { text: `👤 Nome alterado!\n\nAntigo: *${nomeAntigo}*\nNovo: *${novoNome}*` }, { quoted: message });
}

async function handleSetNotifGrupo(message, authorId, chatId) {
    // ... (Função handleSetNotifGrupo original - inalterada) ...
    const user = usuarios[authorId];
    
    if (user.notificationChatId === chatId) {
        return sock.sendMessage(chatId, { text: `Este grupo já está definido como seu grupo de notificações.` }, { quoted: message });
    }
    
    user.notificationChatId = chatId;
    await saveDB(USUARIOS_DB, usuarios);
    
    let groupName = 'Este grupo';
    try {
        const groupMeta = await sock.groupMetadata(chatId);
        groupName = groupMeta.subject;
    } catch (e) { console.warn("Não foi possível pegar o nome do grupo para .set"); }

    await sock.sendMessage(chatId, { text: `✅ Sucesso! Você agora receberá suas notificações de renda passiva em *${groupName}*.` }, { quoted: message });
}

// --- (Item 8) NOVO COMANDO ---
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
        
    await sock.sendMessage(chatId, { text: msg }, { quoted: message });
}

// --- (Item 7) HANDLER ATUALIZADO: Habilidades Consumíveis (Normais)
async function handleUsarHabilidade(message, command, authorId, chatId) {
    const user = usuarios[authorId];
    const hab = (typeof habilidades === 'object' && habilidades) 
        ? habilidades[command] 
        : null;
        
    if (!hab) {
        console.error(`Erro: Skill ${command} nula.`);
        return sock.sendMessage(chatId, { text: `Erro: Skill ${command} nula.` });
    }

    const habIndex = user.habilidades?.findIndex(h => h.toLowerCase() === command);
    if (habIndex === -1 || habIndex === undefined)
        return sock.sendMessage(chatId, { text: `Não possui *${hab.nome}*!` });

    const originalHabId = user.habilidades[habIndex];
    const reqT = hab.duracao_seg && hab.msg_anular;

    // (Item 6) Usa DB de timers persistente
    if (reqT && timers[chatId] && command !== 'zawarudo') {
        return sock.sendMessage(chatId, { text: 'Timer ativo!' });
    }
    
    // --- LÓGICA DE ROTEAMENTO (A PARTE QUE FALTAVA) ---
    
    // 1. Rota para .zawarudo (já estava correta)
    if (command === 'zawarudo') {
        // Consome a skill imediatamente
        user.habilidades.splice(habIndex, 1);
        await saveDB(USUARIOS_DB, usuarios);
        // Chama handler que tenta aplicar as mudanças no grupo
        await handleZawarudo(message, authorId, chatId, originalHabId);
        return;
    }

    // 2. Rota para Habilidades em Área (ex: .belzebu, .vazio_roxo)
    if (hab.affects_all_others) {
        user.habilidades.splice(habIndex, 1); // Consome
        await saveDB(USUARIOS_DB, usuarios);
        await handleSkillArea(message, authorId, chatId, originalHabId, hab, command);
        return;
    }
    
    // 3. Rota para Habilidades de Self-Buff (ex: .mahoraga_adapt)
    if (hab.requires_no_target === true) {
        user.habilidades.splice(habIndex, 1); // Consome
        await saveDB(USUARIOS_DB, usuarios);
        await handleSelfBuffSkill(message, authorId, chatId, hab, command, originalHabId);
        return;
    }

    // --- LÓGICA DE ALVO ÚNICO (A PARTE QUE FALTAVA) ---
    // (Skills de Info ou Ataque que precisam de @alvo)
    
    let rawTargetJid = null;
    let tId = null;
    let targetNumber = null;
    
    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentionedJids.length === 0) {
        return sock.sendMessage(chatId, { text: `Marque um alvo! Uso: *${hab.uso}*` }, { quoted: message });
    }
    
    rawTargetJid = mentionedJids[0];
    tId = normalizeJid(rawTargetJid);
    targetNumber = rawTargetJid.split('@')[0];
    
    if (!usuarios[tId]) return sock.sendMessage(chatId, { text: 'Alvo não cadastrado.' }, { quoted: message });
    if (tId === authorId) return sock.sendMessage(chatId, { text: 'Não pode usar em si mesmo!' }, { quoted: message });
    
    // 4. Rota para Skills de Informação (ex: .olhos_shinigami)
    if (hab.is_info_skill) {
        user.habilidades.splice(habIndex, 1); // Consome
        await saveDB(USUARIOS_DB, usuarios);
        await handleInfoSkill(message, authorId, tId, chatId, hab, command, originalHabId);
        return;
    }
    
    // 5. Rota para Skills de Ataque (Alvo Único) (ex: .deathnote, .mahito)
    // (Esta é a lógica padrão que faltava)
    user.habilidades.splice(habIndex, 1); // Consome
    await saveDB(USUARIOS_DB, usuarios);

    const mId = hab.gif_id || command;
    const vP = path.join(MIDIAS_DIR, `${mId}.mp4`);
    const gP = path.join(MIDIAS_DIR, `${mId}.gif`);
    const authorNumber = authorId.split('@')[0];
    
    try {
        let cap = `🚨 *HAB. ATIVADA!* 🚨\n\n*${user.nome}* (@${authorNumber}) usou *${hab.nome}* em @${targetNumber}!`;
        const men = [denormalizeJid(authorId), denormalizeJid(tId)];
        
        if (hab.duracao_seg && hab.msg_anular) {
            cap += `\n\n@${targetNumber}, você tem *${hab.duracao_seg}s* para anular:\n\n*${hab.msg_anular}*`;
        }
        
        // (Item 6) Salva no DB de timers persistente
        if (hab.duracao_seg && hab.msg_anular) {
            timers[chatId] = { 
                skillId: command, 
                attackerId: authorId, 
                targetId: tId, // Salva o JID normalizado do alvo
                chatId: chatId, 
                expires: Date.now() + (hab.duracao_seg * 1000), 
                msg_anular: hab.msg_anular, 
                affects_all_others: false // É alvo único
            };
            await saveDB(TIMERS_DB, timers);
        } else {
            // (Se for um ataque imediato sem anulação)
            console.warn(`Skill ${command} é de alvo único mas não tem timer?`);
            // (Você não parece ter skills assim, mas se tivesse, a lógica viria aqui)
        }
        
        await enviarMidiaComFallback(chatId, vP, gP, mId, cap, men);

    } catch (sE) {
        console.error(`[SKILL TARGET] Erro ativação ${command}: ${sE.message}`);
        // Devolve a skill se o envio falhar
        user.habilidades.push(originalHabId);
        await saveDB(USUARIOS_DB, usuarios);
        await sock.sendMessage(chatId, { text: `Erro ao usar ${command}. Habilidade devolvida.` });
    }
}

// --- (Item 7) NOVO HANDLER: Skills de Buff Próprio ---
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

        // --- Envio de Mídia ---
        const mId = hab.gif_id || command;
        const vP = path.join(MIDIAS_DIR, `${mId}.mp4`);
        const gP = path.join(MIDIAS_DIR, `${mId}.gif`);
        
        let cap = `✨ *BUFF ATIVADO!* ✨\n\n@${authorNumber} usou *${hab.nome}*!\n\n${hab.msg_sucesso}`;
        const mS = [denormalizeJid(authorId)];

        await enviarMidiaComFallback(chatId, vP, gP, mId, cap, mS); // Helper (Parte 4)

    } catch (e) {
         console.error(`!!! Erro enviar self buff ${command}: ${e.message}`);
         // Devolve a skill se o envio falhar
         user.habilidades.push(originalHabId);
         await saveDB(USUARIOS_DB, usuarios);
         await sock.sendMessage(chatId, { text: `Erro ao usar ${command}. Habilidade devolvida.` });
    }
}


async function handleInfoSkill(message, authorId, targetId, chatId, hab, command, originalHabId) {
    // ... (Função handleInfoSkill original - adaptada para helper de mídia) ...
    try {
        const targetUser = usuarios[targetId];
        if (!targetUser) return; // Segurança

        const totalOuro = (targetUser.ouro || 0) + (targetUser.bank || 0);

        const mId = hab.gif_id || command;
        const vP = path.join(MIDIAS_DIR, `${mId}.mp4`);
        const gP = path.join(MIDIAS_DIR, `${mId}.gif`);
        
        const authorNumber = authorId.split('@')[0];
        const targetNumber = targetId.split('@')[0];
        
        let cap = `👁️ @${authorNumber} usou *${hab.nome}* em @${targetNumber}!\n\n`;
        cap += `*${hab.msg_sucesso}*\n\n`;
        cap += `Saldo Total de @${targetNumber}: *${fmt(totalOuro)} Ouro* (Carteira + Banco)`;
        
        const mS = [denormalizeJid(authorId), denormalizeJid(targetId)];
        
        await enviarMidiaComFallback(chatId, vP, gP, mId, cap, mS); // Helper (Parte 4)

    } catch (e) {
         console.error(`!!! Erro enviar info skill ${command}: ${e.message}`);
         const user = usuarios[authorId];
         // (Item 5) Não devolve se for skill de clã (Beyond)
         if (!hab.is_clan_skill) {
             user.habilidades.push(originalHabId);
             await saveDB(USUARIOS_DB, usuarios);
             await sock.sendMessage(chatId, { text: `Erro ao usar ${command}. Habilidade devolvida.` });
         } else {
             await sock.sendMessage(chatId, { text: `Erro ao usar ${command}.` });
         }
    }
}

// handler para ZA WARUDO — tenta executar as ações sem checar admin explicitamente
async function handleZawarudo(message, authorId, chatId, originalHabId) {
    // pega duração da habilidade (fallback 60s)
    const habDef = habilidades?.['zawarudo'] || {};
    const durationMs = (habDef?.duracao_seg ? habDef.duracao_seg * 1000 : 60_000);

    const authorDenorm = denormalizeJid(authorId); // garante formato ...@s.whatsapp.net
    const authorNumber = authorId.split('@')[0];

    // Arrays para registrar o que deu certo (para reverter depois)
    const affectedPromoted = [];
    const appliedSettings = []; // ex: ['announcement','locked']

    try {
        // 1) Tenta fechar o grupo (modo anúncio / announcement = só admins podem mandar)
        try {
            await sock.groupSettingUpdate(chatId, 'announcement'); // fecha o grupo (apenas admins podem mandar)
            appliedSettings.push('announcement');
            console.log(`[ZA WARUDO] groupSettingUpdate(announcement) ok for ${chatId}`);
        } catch (e) {
            console.warn(`[ZA WARUDO] Falha ao fechar grupo (announcement): ${e.message}`);
        }

        // 2) Opcional: tenta bloquear edição (locked) — ignora se falhar
        try {
            await sock.groupSettingUpdate(chatId, 'locked');
            appliedSettings.push('locked');
            console.log(`[ZA WARUDO] groupSettingUpdate(locked) ok for ${chatId}`);
        } catch (e) {
            console.warn(`[ZA WARUDO] Falha ao lockar grupo: ${e.message}`);
        }

        // 3) Tenta promover o autor (dar adm)
        try {
            await sock.groupParticipantsUpdate(chatId, [authorDenorm], 'promote');
            affectedPromoted.push(authorDenorm);
            console.log(`[ZA WARUDO] Promoted ${authorDenorm} in ${chatId}`);
        } catch (e) {
            console.warn(`[ZA WARUDO] Falha ao promover ${authorDenorm}: ${e.message}`);
        }

        // 4) Registra o timer para reverter depois (skillTimerLoop deve processar isso)
        timers[chatId] = {
            skillId: 'zawarudo',
            attackerId: authorId,
            targetId: null,
            chatId,
            expires: Date.now() + durationMs,
            msg_anular: null,
            affects_all_others: true,
            softMode: false, // já que estamos tentando ações de grupo
            affectedPromoted,
            appliedSettings
        };
        await saveDB(TIMERS_DB, timers);

        // 5) Mensagem de confirmação (MODIFICADA CONFORME PEDIDO)
        
        // --- INÍCIO DA MODIFICAÇÃO ---
        
        // (Request 1: Usar helper de mídia)
        const mId = habDef.gif_id || 'zawarudo';
        const vP = path.join(MIDIAS_DIR, `${mId}.mp4`);
        const gP = path.join(MIDIAS_DIR, `${mId}.gif`);
        
        // (Request 2 & 3: Mudar texto)
        const cap = `⏰ *ZA WARUDO!* ⏰\n@${authorNumber} parou o tempo! O grupo foi fechado por 1 hora!`;
        
        // (Envia a mídia no "estilo" das outras habilidades)
        await enviarMidiaComFallback(chatId, vP, gP, mId, cap, [authorDenorm]);
        
        // --- FIM DA MODIFICAÇÃO ---

    } catch (e) {
        console.error(`[ZA WARUDO] Erro grave ao executar: ${e.message}`);
        // fallback: registra timer em modo "apenas lógico" caso tudo falhe
        timers[chatId] = {
            skillId: 'zawarudo',
            attackerId: authorId,
            targetId: null,
            chatId,
            expires: Date.now() + durationMs,
            msg_anular: null,
            affects_all_others: true,
            softMode: true, // nada foi aplicado no grupo via API
            affectedPromoted: [],
            appliedSettings: []
        };
        await saveDB(TIMERS_DB, timers);
        await sock.sendMessage(chatId, { text: `⚠️ ZA WARUDO executado apenas internamente devido a erro.` });
    }
}

async function handleSkillArea(message, authorId, chatId, originalHabId, hab, command) {
        
    // ... (Função handleSkillArea original - adaptada para helper de mídia e timers.json) ...
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
        
        await enviarMidiaComFallback(chatId, vP, gP, (hab.gif_id || command), cap, men); // Helper (Parte 4)
        
        // (Item 6) Salva em timers.json
        if (hab.duracao_seg && hab.msg_anular) {
            timers[chatId] = { skillId: command, attackerId: authorId, targetId: null, chatId: chatId, expires: Date.now() + (hab.duracao_seg * 1000), msg_anular: hab.msg_anular, affects_all_others: true };
            await saveDB(TIMERS_DB, timers);
        } else {
            // Se for inevitável (ex: .atomic, .madoka, .estrondo, .mugetsu)
            timers[chatId] = { skillId: command, attackerId: authorId, targetId: null, chatId: chatId, expires: Date.now() + 1000, msg_anular: null, affects_all_others: true, is_unavoidable: hab.is_unavoidable };
            await saveDB(TIMERS_DB, timers);
        }

    } catch (sE) {
        console.error(`[SKILL AREA] Erro ativação ${command}: ${sE.message}`);
        let fC = `💥(Erro Mídia)\n\n*${user.nome}* usou *${hab.nome}*!`;
        if (hab.duracao_seg && hab.msg_anular) {
             fC += ` ${hab.duracao_seg}s p/ anular: *${hab.msg_anular}*`;
        }
        await sock.sendMessage(chatId, { text: fC, mentions: [denormalizeJid(authorId)] });
        
        // (Item 6) Salva timer mesmo em fallback de mídia
        if (hab.duracao_seg && hab.msg_anular) {
             timers[chatId] = { skillId: command, attackerId: authorId, targetId: null, chatId: chatId, expires: Date.now() + (hab.duracao_seg * 1000), msg_anular: hab.msg_anular, affects_all_others: true };
        } else {
             timers[chatId] = { skillId: command, attackerId: authorId, targetId: null, chatId: chatId, expires: Date.now() + 1000, msg_anular: null, affects_all_others: true, is_unavoidable: hab.is_unavoidable };
        }
        await saveDB(TIMERS_DB, timers);
    }
}

// --- (Item 5) NOVO HANDLER: Habilidades de Clã (Não-consumíveis)
async function handleUsarHabilidadeCla(message, command, authorId, chatId) {
    const user = usuarios[authorId];
    const hab = (typeof habilidades === 'object' && habilidades) 
        ? habilidades[command] 
        : null;
        
    if (!hab || !hab.is_clan_skill) {
        console.error(`Erro: Skill de clã ${command} nula ou mal configurada.`);
        return sock.sendMessage(chatId, { text: `Erro: Skill de clã ${command} nula.` });
    }

    // 1. Verifica se o usuário tem a skill (segurança)
    const habIndex = user.habilidades?.findIndex(h => h.toLowerCase() === command);
    if (habIndex === -1 || habIndex === undefined)
        return sock.sendMessage(chatId, { text: `Você não deveria ter *${hab.nome}*! (Não pertence ao clã?)` });
    
    const originalHabId = user.habilidades[habIndex];
    
    // 2. Verifica Cooldown
    user.cooldowns = user.cooldowns || {};
    const n = Date.now();
    const cdKey = command.startsWith('.') ? command.substring(1) : command; // Remove prefixo se houver
    const cd = user.cooldowns[cdKey] || 0;
    
    if (n < cd) {
        return sock.sendMessage(chatId, { text: `⏳ Habilidade *${hab.nome}* em cooldown! (${timeLeft(cd)})` }, { quoted: message });
    }
    
    // 3. Aplica Cooldown (NÃO consome a skill)
    const C = (hab.cooldown_sec || 300) * 1000; // Padrão 5 min
    user.cooldowns[cdKey] = n + C;
    await saveDB(USUARIOS_DB, usuarios); // Salva o novo cooldown

    // 4. Roteia para a lógica correta (Info, Self-Buff, etc.)
    
    // Rota para Habilidades de Self-Buff (ex: .instinto_superior)
    if (hab.requires_no_target === true) {
        await handleSelfBuffSkill(message, authorId, chatId, hab, command, originalHabId);
        return;
    }

    // --- Lógica de Alvo Único (Obrigatório para o resto) ---
    let rawTargetJid = null;
    let tId = null;
    
    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentionedJids.length === 0) {
        return sock.sendMessage(chatId, { text: `Marque um alvo! Uso: *${hab.uso}*` }, { quoted: message });
    }
    
    rawTargetJid = mentionedJids[0];
    tId = normalizeJid(rawTargetJid);
    
    if (!usuarios[tId]) return sock.sendMessage(chatId, { text: 'Alvo não cadastrado.' }, { quoted: message });
    if (tId === authorId) return sock.sendMessage(chatId, { text: 'Não pode usar em si mesmo!' }, { quoted: message });
    
    // Rota para Skills de Informação (ex: .olhos_shinigami)
    if (hab.is_info_skill) {
        await handleInfoSkill(message, authorId, tId, chatId, hab, command, originalHabId);
        return;
    }
    
    // Rota para Skills de Ataque de Clã (ex: .mangekyou_inicial)
    // (Esta lógica é idêntica ao handleUsarHabilidade, mas SEM consumir)
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
        
        // Salva no DB de timers persistente
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
        // (Não devolve a skill, pois não foi gasta)
        await sock.sendMessage(chatId, { text: `Erro ao usar ${command}.` });
    }
}

// --- FUNÇÕES DE ECONOMIA (Helpers e Banco) ---
// (Helpers `fmt`, `timeLeft`, `parseAmount` movidos para a Parte 4)

async function handleBanco(m, a, chatId) {
    const u = usuarios[a];
    u.bank = u.bank || 0;
    await sock.sendMessage(chatId, { text: `🏦 *Banco*\nSaldo: ${fmt(u.bank)} Ouro` });
}

async function handleCarteira(m, a, chatId) {
    const u = usuarios[a];
    const text = `💰 *Carteira*\n\nCarteira: ${fmt(u.ouro || 0)} 💰\nBanco: ${fmt(u.bank || 0)} 🏦`;
    await sock.sendMessage(chatId, { text: text }, { quoted: m });
}

async function handleDepositar(m, g, a, chatId) {
    // ... (Função handleDepositar original - inalterada) ...
    const u = usuarios[a];
    u.ouro = u.ouro || 0;
    u.bank = u.bank || 0;
    u.cooldowns = u.cooldowns || {};

    const DEPOSIT_COOLDOWN = 1 * 60 * 60 * 1000; // 1 hora
    const c = u.cooldowns.deposit || 0;
    const n = Date.now();
    if (n < c) {
        return sock.sendMessage(chatId, { text: `⏳ Você só pode depositar novamente em ${timeLeft(c)}.` }, { quoted: m });
    }

    const o = parseAmount(g[0], u.ouro); // Helper (Parte 4)
    if (!isFinite(o) || o <= 0) return sock.sendMessage(chatId, { text: `🤔 Valor inválido! Use *.depositar <valor | all>*` }, { quoted: m });
    if (o > u.ouro) return sock.sendMessage(chatId, { text: `😥 Você não tem ${fmt(o)} Ouro.` }, { quoted: m });
    
    u.ouro -= o;
    u.bank += o;
    u.cooldowns.deposit = n + DEPOSIT_COOLDOWN; // Aplica o cooldown
    
    await saveDB(USUARIOS_DB, usuarios);
    await sock.sendMessage(chatId, { text: `✅ Depositado ${fmt(o)}.\nCarteira: ${fmt(u.ouro)}\nBanco: ${fmt(u.bank)}` });
}

async function handleSacar(m, g, a, chatId) {
    // ... (Função handleSacar original - inalterada) ...
    const u = usuarios[a];
    u.ouro = u.ouro || 0;
    u.bank = u.bank || 0;
    const o = parseAmount(g[0], u.bank); // Helper (Parte 4)
    if (!isFinite(o) || o <= 0) return sock.sendMessage(chatId, { text: `🤔 Valor inválido! Use *.sacar <valor | all>*` }, { quoted: m });
    if (o > u.bank) return sock.sendMessage(chatId, { text: `😥 Saldo insuficiente (${fmt(u.bank)}).` }, { quoted: m });
    u.bank -= o;
    u.ouro += o;
    await saveDB(USUARIOS_DB, usuarios);
    await sock.sendMessage(chatId, { text: `✅ Sacado ${fmt(o)}.\nCarteira: ${fmt(u.ouro)}\nBanco: ${fmt(u.bank)}` });
}

async function handlePix(m, args, authorId, chatId) {
    // ... (Função handlePix original - inalterada) ...
    const u = usuarios[authorId];
    u.cooldowns = u.cooldowns || {};
    
    const PIX_COOLDOWN = 30 * 60 * 1000; // 30 minutos
    const c = u.cooldowns.pix || 0;
    const n = Date.now();
    if (n < c) {
        return sock.sendMessage(chatId, { text: `⏳ Você só pode fazer *.pix* novamente em ${timeLeft(c)}.` }, { quoted: m });
    }

    const amount = parseAmount(args[0], u.ouro); // Helper (Parte 4)
    
    let rawTargetJid = null;
    let tId = null;
    let targetNumber = null;
    
    const mentionedJids = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentionedJids.length === 0) {
        return sock.sendMessage(chatId, { text: `Marque o usuário para quem quer transferir! Use: *.pix <valor> @alvo*` }, { quoted: m });
    }
    
    rawTargetJid = mentionedJids[0];
    tId = normalizeJid(rawTargetJid);
    targetNumber = rawTargetJid.split('@')[0];
    
    const targetUser = usuarios[tId];
    if (!targetUser) return sock.sendMessage(chatId, { text: 'Alvo não cadastrado.' }, { quoted: m });
    if (tId === authorId) return sock.sendMessage(chatId, { text: 'Não pode transferir para si mesmo!' }, { quoted: m });
    
    if (!isFinite(amount) || amount <= 0) return sock.sendMessage(chatId, { text: `🤔 Valor inválido! Use *.pix <valor | all> @alvo*` }, { quoted: m });
    if (amount > u.ouro) return sock.sendMessage(chatId, { text: `😥 Você não tem ${fmt(amount)} Ouro na carteira.` }, { quoted: m });

    u.ouro -= amount;
    targetUser.ouro = (targetUser.ouro || 0) + amount;
    u.cooldowns.pix = n + PIX_COOLDOWN;
    
    await saveDB(USUARIOS_DB, usuarios);
    
    const authorNumber = authorId.split('@')[0];
    const replyText = `💸 *Transferência PIX*\n\n@${authorNumber} enviou *${fmt(amount)} Ouro* para @${targetNumber}!`;
    
    await sock.sendMessage(chatId, {
        text: replyText,
        mentions: [denormalizeJid(authorId), denormalizeJid(tId)],
    });
}


// --- (Item 7) ADM COMMAND ATUALIZADO ---
async function handleAddMoney(m, g, a, chatId) {
    // Pega o JID real do participante da mensagem (não normalizado)
    const rawAuthorJid = m.key.participant || m.key.remoteJid;
    // Extrai o número do telefone do JID real
    const authorNumber = rawAuthorJid.split('@')[0];
    const ownerNumber = '5528981124442'; // Número do dono
    
    if (authorNumber !== ownerNumber) {
        console.log(`[DEBUG] Comando .add negado para ${authorNumber} (Não é o dono ${ownerNumber})`);
        return; // Ignora silenciosamente se não for o dono
    }
    
    console.log(`[DEBUG] Comando .add autorizado para o dono ${ownerNumber}`);

    let targetId = a; // Default: a si mesmo
    let amountStr = g[0];
    
    const mentionedJids = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    
    if (mentionedJids.length > 0) {
        // Formato: .add <qtd> @alvo
        amountStr = g[0];
        targetId = normalizeJid(mentionedJids[0]);
    } else if (g.length > 1) {
         // Tenta detectar se o @alvo foi o segundo argumento (sem @)
         // Esta é uma heurística fraca, a menção é preferida.
         // Se g[1] for um JID, usa. Senão, assume que é parte da <qtd>
         if (g[1].includes('@c.us') || g[1].includes('@s.whatsapp.net')) {
             amountStr = g[0];
             targetId = normalizeJid(g[1]);
         }
    }

    const u = usuarios[targetId];
    if (!u) {
        return sock.sendMessage(chatId, { text: 'Alvo não encontrado no DB.' }, { quoted: m });
    }

    const amount = parseInt(amountStr);
    if (isNaN(amount)) { // Permite add negativo (remover)
        return sock.sendMessage(chatId, { text: 'Valor inválido. Use *.add <quantidade> [@alvo]*' }, { quoted: m });
    }
    
    u.ouro = (u.ouro || 0) + amount;
    await saveDB(USUARIOS_DB, usuarios);
    
    const action = amount > 0 ? "Adicionado" : "Removido";
    const amountAbs = Math.abs(amount);
    
    await sock.sendMessage(chatId, { text: `✅ (ADM) ${action} ${fmt(amountAbs)} Ouro.\nAlvo: *${u.nome}*\nNovo saldo: ${fmt(u.ouro)}` }, { quoted: m });
}


// --- FUNÇÕES DE GANHO (ECONOMIA) ---

// --- (Item 4) HANDLER: .diario (CORRIGIDO COM TIMEZONE)
async function handleDiario(message, authorId, chatId) {
    const user = usuarios[authorId];
    user.cooldowns = user.cooldowns || {};
    
    // --- CORREÇÃO DE TIMEZONE ---
    const today = getDateInBrasilia(); // Pega a data YYYY-MM-DD de Brasília

    if (user.cooldowns.diario === today) {
        return sock.sendMessage(chatId, { text: `Você já pegou seu prêmio diário hoje! Volte amanhã.` }, { quoted: message });
    }

    const premio = Math.floor(Math.random() * 4001) + 1000; // 1000 a 5000
    user.ouro = (user.ouro || 0) + premio;
    
    // Salva a string da data de Brasília como cooldown
    user.cooldowns.diario = today;
    
    await saveDB(USUARIOS_DB, usuarios);

    await sock.sendMessage(chatId, {
        text: `🎁 *Prêmio Diário!*\nVocê recebeu *${fmt(premio)}* de Ouro!`,
        mentions: [denormalizeJid(authorId)]
    }, { quoted: message });
}

async function handleTrabalhar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.work || 0, n = Date.now(), C = 7 * 60 * 1000;
    if (n < c) return sock.sendMessage(chatId, { text: `⏳ Descanse! Volte em ${timeLeft(c)}.` }, { quoted: m });
    
    const b = 180 + Math.floor(Math.random() * 181); // Antes: 200-400
    const l = getBuffMultiplier(u, 'activity_bonus'), t = Math.round(b * l);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.work = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await sock.sendMessage(chatId, { text: `💼 Trabalhou e ganhou ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handleMinerar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.mine || 0, n = Date.now(), C = 5 * 60 * 1000;
    if (n < c) return sock.sendMessage(chatId, { text: `⏳ Mina esgotada! Volte em ${timeLeft(c)}.` }, { quoted: m });
    
    const g = 110 + Math.floor(Math.random() * 111); // Antes: 120-240
    const l = getBuffMultiplier(u, 'activity_bonus'), t = Math.round(g * l);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.mine = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await sock.sendMessage(chatId, { text: `⛏️ Minerou ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handlePescar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.fish || 0, n = Date.now(), C = 6 * 60 * 1000;
    if (n < c) return sock.sendMessage(chatId, { text: `⏳ Peixes sumiram! Volte em ${timeLeft(c)}.` }, { quoted: m });
    
    const g = 140 + Math.floor(Math.random() * 141); // Antes: 160-320
    const l = getBuffMultiplier(u, 'activity_bonus'), t = Math.round(g * l);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.fish = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await sock.sendMessage(chatId, { text: `🎣 Vendeu peixes por ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handleFazerBolo(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.fazerbolo || 0, n = Date.now(), C = 6 * 60 * 1000;
    if (n < c) return sock.sendMessage(chatId, { text: `⏳ Cozinha bagunçada! Volte em ${timeLeft(c)}.` }, { quoted: m });

    u.cooldowns.fazerbolo = n + C;
    
    if (Math.random() < 0.5) {
        const baseGain = 130 + Math.floor(Math.random() * 131); // Antes: 140-280
        const activityMultiplier = getBuffMultiplier(u, 'activity_bonus');
        const totalGain = Math.round(baseGain * activityMultiplier);
        
        u.ouro = (u.ouro || 0) + totalGain;
        await saveDB(USUARIOS_DB, usuarios);
        await sock.sendMessage(chatId, { text: `🎂 ${u.nome} fez um bolo de baunilha delicioso e ganhou ${fmt(totalGain)} Ouro!${activityMultiplier > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
    } else {
        await saveDB(USUARIOS_DB, usuarios);
        await sock.sendMessage(chatId, { text: `😷 ${u.nome} tentou fazer um bolo e acabou criando um bolo de cocô 💩 kkkkk` }, { quoted: m });
    }
}

async function handleForjar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.forjar || 0, n = Date.now(), C = 6 * 60 * 1000;
    if (n < c) return sock.sendMessage(chatId, { text: `⏳ Fornalha fria! Volte em ${timeLeft(c)}.` }, { quoted: m });

    u.cooldowns.forjar = n + C;
    
    const isTsugikuni = u.cla_id === 'tsugikuni';
    
    if (isTsugikuni || Math.random() < 0.5) {
        const baseGain = 140 + Math.floor(Math.random() * 141); // Antes: 150-300
        let activityMultiplier = getBuffMultiplier(u, 'activity_bonus');
        let forjarMultiplier = 1.0;
        let bonusMsg = "";

        if (isTsugikuni) {
            const claBuff = clas.find(c => c.id === 'tsugikuni')?.buff;
            forjarMultiplier = claBuff?.multiplier || 3.0;
            bonusMsg = " (Respiração do Sol x3!)";
        }
        if (activityMultiplier > 1.0 && bonusMsg === "") bonusMsg = " (Bônus!)";

        const totalGain = Math.round(baseGain * activityMultiplier * forjarMultiplier);
        u.ouro = (u.ouro || 0) + totalGain;
        await saveDB(USUARIOS_DB, usuarios);
        await sock.sendMessage(chatId, { text: `🔥 Forja bem-sucedida! Você criou uma lâmina e vendeu por ${fmt(totalGain)} Ouro!${bonusMsg}` }, { quoted: m });
    } else {
        await saveDB(USUARIOS_DB, usuarios);
        await sock.sendMessage(chatId, { text: `💥 Falha! A lâmina quebrou na forja. Você não ganhou nada e perdeu materiais.` }, { quoted: m });
    }
}


async function handleExplorar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.explore || 0, n = Date.now(), C = 8 * 60 * 1000;
    if (n < c) return sock.sendMessage(chatId, { text: `⏳ Área perigosa! Volte em ${timeLeft(c)}.` }, { quoted: m });
    
    const g = 220 + Math.floor(Math.random() * 221); // Antes: 250-500
    const l = getBuffMultiplier(u, 'activity_bonus'), t = Math.round(g * l);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.explore = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await sock.sendMessage(chatId, { text: `🧭 Explorou e achou ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handleCaçar(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.hunt || 0, n = Date.now(), C = 9 * 60 * 1000;
    if (n < c) return sock.sendMessage(chatId, { text: `⏳ Animais fugiram! Volte em ${timeLeft(c)}.` }, { quoted: m });
    
    const g = 260 + Math.floor(Math.random() * 261); // Antes: 300-600
    const l = getBuffMultiplier(u, 'activity_bonus'), t = Math.round(g * l);
    u.ouro = (u.ouro || 0) + t;
    u.cooldowns.hunt = n + C;
    await saveDB(USUARIOS_DB, usuarios);
    await sock.sendMessage(chatId, { text: `🏹 Caçou e vendeu peles por ${fmt(t)} Ouro!${l > 1.0 ? ' (Bônus!)' : ''}` }, { quoted: m });
}

async function handleCrime(m, a, chatId) {
    const u = usuarios[a];
    u.cooldowns = u.cooldowns || {};
    const c = u.cooldowns.crime || 0, n = Date.now(), C = 10 * 60 * 1000;
    if (n < c) return sock.sendMessage(chatId, { text: `⏳ Disfarce! Espere ${timeLeft(c)}.` }, { quoted: m });
    
    let sC = 0.4, gM = 1.0, bonusMsg = "";
    
    // (Item 5) Lógica Clã Demônio/Oni
    if (u.cla_id === 'demonio') {
        sC = 1.0; // 100% chance
        const d = clas.find(c => c.id === 'demonio');
        gM = d?.buff?.multiplier || 1.5; // +50% ganho
        bonusMsg = " (Bônus de Oni!)";
    }
    
    const suc = Math.random() < sC;
    const actM = getBuffMultiplier(u, 'activity_bonus');
    if (actM > 1.0 && bonusMsg === "") bonusMsg = " (Bônus!)";
    
    if (suc) {
        const bG = 70 + Math.floor(Math.random() * 141); // Antes: 80-240
        const tG = Math.round(bG * actM * gM);
        u.ouro = (u.ouro || 0) + tG;
        u.cooldowns.crime = n + C;
        await saveDB(USUARIOS_DB, usuarios);
        await sock.sendMessage(chatId, { text: `💰 Crime perfeito! Lucrou ${fmt(tG)} Ouro.${bonusMsg}` }, { quoted: m });
    } else {
        const f = 35 + Math.floor(Math.random() * 71); // Antes: 40-120
        const p = Math.min(u.ouro || 0, f);
        u.ouro = (u.ouro || 0) - p;
        u.cooldowns.crime = n + C;
        await saveDB(USUARIOS_DB, usuarios);
        await sock.sendMessage(chatId, { text: `🚓 Pego! Multa de ${fmt(p)} Ouro.` }, { quoted: m });
    }
}

async function handleMenuGold(message, authorId, chatId) {
    // ... (Função handleMenuGold original - adaptada para helper de mídia e novos comandos) ...
    const user = usuarios[authorId];
    const authorNumber = authorId.split('@')[0];
    const top = '╭ೋ🪙ೋ•═══════════╗', mid = '🪙', sep = '════════ •『 💰 』• ════════', bot = '╚═══════════•ೋ🪙ೋ╯', icon = '✨';

    // --- CORREÇÃO DO MENU (Bug 6) ---
    let txt = `${top}\n${mid} *Menu Economia @${authorNumber}*\n${mid}\n${mid} *Ouro:*\n${mid}   ${icon} Carteira: ${fmt(user.ouro || 0)}💰\n${mid}   ${icon} Banco: ${fmt(user.bank || 0)}🏦\n${mid} ${sep}\n${mid} *Banco/Transferência:*\n${mid}   ${icon} .banco\n${mid}   ${icon} .depositar <v|all>\n${mid}   ${icon} .sacar <v|all>\n`;
    txt += `${mid}   ${icon} .carteira\n`; // <-- ADICIONADO AQUI
    txt += `${mid}   ${icon} .trade <id> @alvo\n`; // <-- ADICIONADO AQUI
    txt += `${mid}   ${icon} .pix <v|all> @alvo\n${mid} ${sep}\n${mid} *Ganhos:*\n${mid}   ${icon} .diario\n${mid}   ${icon} .trabalhar\n${mid}   ${icon} .minerar\n${mid}   ${icon} .pescar\n${mid}   ${icon} .forjar\n${mid}   ${icon} .fazerbolo\n${mid}   ${icon} .explorar\n${mid}   ${icon} .caçar\n${mid}   ${icon} .crime\n${mid} ${sep}\n`;
    
    // Bloco "Comércio/Perfil" removido do final e unificado
    txt += `${mid} *Comércio & Clãs:*\n`;
    txt += `${mid}   ${icon} .loja\n`;
    txt += `${mid}   ${icon} .habilidades\n`;
    txt += `${mid}   ${icon} .clas\n`;
    txt += `${mid}   ${icon} .girarcla (Custo: ${fmt(CUSTO_GIRAR_CLA)})\n`;
    txt += `${mid}   ${icon} .listarclas\n`;
    txt += `${mid}   ${icon} .menu\n`;
    txt += `${mid}   ${icon} .configurar\n${bot}`;
    // --- FIM DA CORREÇÃO ---

    const vP = path.join(MIDIAS_DIR, 'menugold.mp4');
    const gP = path.join(MIDIAS_DIR, 'menugold.gif');
    const iP = path.join(MIDIAS_DIR, 'menugold.jpg');
    
    await enviarMidiaComFallback(chatId, vP, gP, 'menugold', txt, [denormalizeJid(authorId)], iP);
}

// --- FUNÇÕES DE LOOP (v4.0 - Persistência) ---

// (Item 2, 6, 8) Loop de Renda Passiva
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

                    // Calcula Cooldown com buff de clã (Senju - Item 5)
                    let c = itemData.cooldown_min * 60000;
                    let cM = getBuffMultiplier(user, 'cooldown_reduction'); // (Item 5) Pega 0.75
                    c *= cM;
                    const cFinal = Math.max(10000, c); // Mínimo 10s
                    
                    // Atualiza o timer ANTES de pagar
                    userPayouts[itemId] = now + cFinal;
                    payoutDbChanged = true;

                    // Calcula Renda (Uzumaki, Tsugikuni)
                    let r = itemData.renda;
                    let iM = getBuffMultiplier(user, 'passive_income_boost');
                    let bonusMsg = "";
                    
                    if (user.cla_id === 'tsugikuni' && catId === 'demon_slayer') {
                        r *= 1.50; // +50%
                        iM = 1.0;
                        bonusMsg = ' (Respiração do Sol!)';
                    }
                    
                    r *= iM;
                    if (iM > 1.0) bonusMsg = ' (Bônus Uzumaki!)';
                    
                    const rF = Math.round(r);
                    user.ouro = (user.ouro || 0) + rF;
                    userDbChanged = true;
                    
                    // (Item 8) Verifica se o usuário quer a notificação
                    const userToggles = settings.userToggles || {};
                    const notifOff = userToggles[userId]?.rendaOff || false;

                    if (notifOff) {
                        console.log(`[LOOP] Pago ${fmt(rF)} (silenciosamente) para ${user.nome} (item ${itemId})`);
                        continue;
                    }

                    // (Item 2) Envia notificação
                    const targetChatId = user.notificationChatId || user.lastKnownChatId;
                    if (targetChatId) {
                        // (Item 2) Não marca, usa o NOME
                        let msg = itemData.mensagem_ganho.replace('{nome}', user.nome).replace('{renda}', fmt(rF));
                        msg += bonusMsg;
                        
                        const mediaId = itemData.gif_id || itemId;
                        const vP = path.join(MIDIAS_DIR, `${mediaId}.mp4`);
                        const gP = path.join(MIDIAS_DIR, `${mediaId}.gif`);
                        
                        // Não espera (await) o envio da mídia, só dispara
                        enviarMidiaComFallback(targetChatId, vP, gP, mediaId, msg, []);
                        
                    } else console.warn(`User ${user.nome}(${userId}) sem chat para renda.`);

                } catch (lE) {
                    console.error(`!!! ERRO RENDA ${user.nome}(${userId}), item ${itemId}: ${lE.message}`);
                    // Adia o pagamento em 15 min em caso de erro
                    userPayouts[itemId] = now + (15 * 60 * 1000);
                    payoutDbChanged = true;
                }
            }
        }
    }
    
    if (payoutDbChanged) await saveDB(PAYOUTS_DB, payouts);
    if (userDbChanged) await saveDB(USUARIOS_DB, usuarios);
}

// (Item 5) NOVO LOOP: Cooldowns de Clã
async function clanCooldownLoop(sockInstance) {
    if (!sockInstance) return;
    const now = Date.now();
    let dbChanged = false;
    
    for (const userId in usuarios) {
        const user = usuarios[userId];
        
        // 1. Clã Gojo (Mugen Recharge)
        if (user.cla_id === 'gojo') {
            const charges = user.mugen_charges || 0;
            const cd = user.mugen_cooldown || 0;
            if (charges < 1 && now >= cd) {
                user.mugen_charges = 1;
                // Define o próximo CD (2 horas)
                user.mugen_cooldown = now + (2 * 60 * 60 * 1000); 
                dbChanged = true;
                console.log(`[LOOP CLÃ] Carga de Mugen regenerada para ${user.nome} (${userId})`);
                // (Item 5) Não notifica o usuário
            }
        }
        
        // 2. Clã Sayajin (Instinto Superior Recharge)
        if (user.cla_id === 'saiyajin') {
            // (Lógica de cooldown será aplicada no skillTimerLoop ao usar)
            // Este loop pode ser usado se o IS se tornar passivo com cargas no futuro
        }
    }
    
    if (dbChanged) {
        await saveDB(USUARIOS_DB, usuarios);
    }
}

// --- (Item 8) VERIFICAÇÃO DE DESCONTO (CORRIGIDO COM TIMEZONE E BLINDADO) ---
async function checkDailyDiscount() {
    console.log('[DISCOUNT] Verificando desconto diário...');
    // Pega a data YYYY-MM-DD de Brasília
    const today = getDateInBrasilia(); 
    
    if (settings.lastDiscountDate !== today) {
        console.log(`[DISCOUNT] Novo dia (${today})! Sorteando novo desconto...`);
        settings.lastDiscountDate = today;
        
        // --- CORREÇÃO DE CRASH (Bug do lojas.map) ---
        // O novo sistema (v4.0) espera que 'lojas.json' seja um Array [].
        // O sistema antigo (v3.4) usava um Objeto {}.
        // Esta checagem impede o bot de crashar se 'lojas.json' for o antigo.
        if (!Array.isArray(lojas)) {
            console.error('[DISCOUNT] ERRO: A variável "lojas" não é um Array! (Tipo: ' + (typeof lojas) + ')');
            console.warn('[DISCOUNT] Pulando sorteio de desconto. Verifique se seu "lojas.json" é compatível com o sistema v4.0 (deve ser um Array).');
            // Salva a data para não tentar de novo
            await saveDB(SETTINGS_DB, settings);
            return; // Sai da função para não crashar
        }
        // --- FIM DA CORREÇÃO ---

        // 1. Reseta o desconto antigo
        if (settings.discountAnime) {
            const lA = lojas.find(l => l.anime === settings.discountAnime);
            if (lA) lA.desconto = 0;
        }
        
        // 2. Sorteia o novo
        // Esta é a linha que deu o erro (agora protegida pela checagem acima)
        const animes = [...new Set(lojas.map(l => l.anime).filter(a => a))];
        
        if (animes.length === 0) {
            console.warn('[DISCOUNT] Nenhum anime encontrado em lojas.json para sortear desconto.');
            await saveDB(SETTINGS_DB, settings);
            return; // Sai se não houver animes
        }
        
        const animeSorteado = animes[Math.floor(Math.random() * animes.length)];
        const lojaSorteada = lojas.find(l => l.anime === animeSorteado);
        
        const desconto = (Math.floor(Math.random() * 6) + 2) * 5; // 10% a 35%
        lojaSorteada.desconto = desconto / 100; // Salva como 0.10, 0.35 etc
        
        settings.discountAnime = animeSorteado;
        settings.discountAmount = desconto;
        
        await saveDB(SETTINGS_DB, settings);
        console.log(`[DISCOUNT] Desconto de ${desconto}% aplicado na loja ${animeSorteado}.`);
        
    } else {
        console.log(`[DISCOUNT] Desconto do dia (${today}) já aplicado.`);
    }
}

// --- FUNÇÕES AUXILIARES (v4.0) ---

// (Item 7) NOVO HELPER: Envio de Mídia com Fallback
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
            await sock.sendMessage(chatId, options);
        } else {
            console.warn(`!!! Mídia (mp4, gif) ${mId} não enc.: ${vP} ou ${gP}.`);
            options.text = `🎬 (Mídia ${mId} não enc.)\n\n${caption}`;
            await sock.sendMessage(chatId, options);
        }
    } catch (sE) {
        console.error(`!!! Erro enviar mídia ${mId}: ${sE.message}`);
        await sock.sendMessage(chatId, { text: `🎬 (Erro Mídia)\n\n${caption}`, mentions: mentions });
    }
}

// (Item 6, 7) NOVO HELPER: Cálculo Dinâmico de Preço
function getDynamicPrice(item, itemId, user, type) {
    let finalPrice = item.preco;
    let discountMsg = "";
    
    // 1. Desconto Diário (Habilidades)
    if (type === 'habilidade' && settings.dailyDiscount?.id === itemId && Date.now() < settings.dailyDiscount.expires) {
        finalPrice = Math.floor(finalPrice * 0.5);
        discountMsg = " (50% Oferta do Dia!)";
        return { finalPrice, discountMsg }; // Desconto diário sobrepõe clãs
    }
    
    // 2. Descontos de Clã
    const isGojo = user.cla_id === 'gojo';
    const isShinigami = user.cla_id === 'shinigami';

    if (isGojo) {
        if (type === 'loja' && item.categoria === 'jujutsu_kaisen') { // (Precisa que `findItemInLoja` retorne `item.categoria`)
             // Nota: `item` não tem `categoria`. O `catId` foi pego no `handleCompraLojaItem`.
             // Esta lógica é tratada no `handleCompraLojaItem` onde o `catId` está disponível.
             // Aqui, verificamos Habilidades JJK.
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

// (Helpers de DB - Usados na Parte 2)
function sortearCla(clasArray) {
    if (!Array.isArray(clasArray) || clasArray.length === 0) { console.error("Erro: array clãs inválido."); return null; }
    let pool = [];
    clasArray.forEach(c => { 
        const n = (typeof c.chance === 'number' && c.chance > 0) ? c.chance : (c.chance === 0 ? 0 : 1); 
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

// (Helpers de Formatação - Usados na Parte 2 e 3)
function fmt(n) { const num = typeof n === 'number' ? n : 0; return new Intl.NumberFormat('pt-BR').format(Math.floor(num)); }
function timeLeft(tM) { const d=tM-Date.now(); if(d<=0)return'agora'; const s=Math.ceil(d/1000),m=Math.floor(s/60),rs=s%60,h=Math.floor(m/60),rm=m%60,D=Math.floor(h/24),rH=h%24; let p=[]; if(D>0)p.push(`${D}d`); if(rH>0)p.push(`${rH}h`); if(rm>0&&D===0)p.push(`${rm}m`); if(rs>0&&h===0&&D===0)p.push(`${rs}s`); return p.length>0?p.join(' '):'agora'; }
function parseAmount(t,max){ if(!t)return NaN; const l=t.trim().toLowerCase(); if(['all','tudo','max'].includes(l))return max; let m=1; if(l.endsWith('k'))m=1000; if(l.endsWith('m'))m=1000000; const n=parseFloat(l.replace(/[^0-9.]/g,''))*m; return isNaN(n)?NaN:Math.max(0,Math.floor(n)); }


// --- (Item 6, 5, 7) LOOP DE SKILL ATUALIZADO (FINAL + SUPORTE ZA WARUDO) ---
async function skillTimerLoop(sockInstance) {
    if (!sockInstance) return;
    const now = Date.now();
    let timersDbChanged = false;
    let userDbChanged = false;
    let payoutDbChanged = false; // (Adicionado para correção do Madoka)
    
    // (Item 6) Itera sobre o DB de timers persistente
    for (const chatId in timers) {
        const timer = timers[chatId];
        if (now >= timer.expires) {
            console.log(`[SKILL] Timer expirado ${timer.skillId} chat ${chatId}.`);
            
            const skill = (typeof habilidades === 'object' && habilidades) ? habilidades[timer.skillId] : null;
            const attacker = usuarios[timer.attackerId];
            
            // Deleta o timer ANTES de processar
            delete timers[chatId];
            timersDbChanged = true;
            
            const getNum = (jid) => jid.split('@')[0];
            
            // --- (NOVO BLOCO) Reversão do ZA WARUDO ---
            if (timer.skillId === 'zawarudo') {
                console.log(`[ZA WARUDO-REVERT] Revertendo efeitos em ${chatId}...`);
                try {
                    const promoted = timer.affectedPromoted || [];
                    const settings = timer.appliedSettings || [];

                    // 1) Reverte promoção (tira admin)
                    for (const pj of promoted) {
                        try {
                            await sockInstance.groupParticipantsUpdate(chatId, [pj], 'demote');
                            console.log(`[ZA WARUDO-REVERT] Demoted ${pj} em ${chatId}`);
                        } catch (e) {
                            console.warn(`[ZA WARUDO-REVERT] Falha ao demitir ${pj}: ${e.message}`);
                        }
                    }

                    // 2) Reabre o grupo (se foi fechado)
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

                    // 3) Mensagem de fim do efeito
                    try {
                        await sockInstance.sendMessage(chatId, {
                            text: `⏰ *ZA WARUDO!* acabou — o tempo voltou ao normal.`
                        });
                    } catch (e) {
                        console.warn(`[ZA WARUDO-REVERT] Falha ao enviar notificação de fim: ${e.message}`);
                    }
                } catch (e) {
                    console.error(`[ZA WARUDO-REVERT] Erro ao reverter efeitos: ${e.message}`);
                }
                continue; // passa pro próximo timer
            }

            // --- HABILIDADES EM ÁREA (v3.3 -> v4.0) ---
            if (timer.affects_all_others) {
                if (!attacker || !skill) { console.warn(`[SKILL] Atac/skill Área nulo.`); continue; }
                
                let totalOuroRoubado = 0;
                const mencoes = [denormalizeJid(timer.attackerId)];
                const multiplier = skill.multiplier || 1.0;
                const resets_targets = skill.resets_targets || false;
                const is_unavoidable = timer.is_unavoidable || skill.is_unavoidable || false;
                
                for (const uId in usuarios) {
                    if (uId === timer.attackerId || (usuarios[uId].ouro || 0) <= 0) continue;
                    
                    const target = usuarios[uId];
                    const ouroAlvo = target.ouro || 0;
                    
                    // --- DEFESAS PASSIVAS ---
                    if (timer.skillId === 'vazio_roxo' && target.cla_id === 'gojo') {
                        try { sockInstance.sendMessage(timer.chatId, { text: `♾️ ${target.nome} (Gojo) é imune ao Vazio Roxo!` }); } catch {}
                        continue;
                    }

                    if (skill.anime === 'Jujutsu Kaisen' && (target.buffs?.mahoraga_adapt || 0) > now) {
                        try { sockInstance.sendMessage(timer.chatId, { text: `☸️ ${target.nome} está adaptado! O ataque JJK foi anulado!` }); } catch {}
                        continue;
                    }

                    if (!is_unavoidable) {
                        const bVI = target.habilidades?.indexOf('blut_vene');
                        if (bVI !== -1 && bVI !== undefined) {
                            target.habilidades.splice(bVI, 1);
                            userDbChanged = true;
                            try { sockInstance.sendMessage(timer.chatId, { text: `🛡️ Blut Vene! ${target.nome} anulou o ataque em área!` }); } catch {}
                            continue;
                        }
                        if ((target.mugen_charges || 0) > 0) {
                            target.mugen_charges -= 1;
                            userDbChanged = true;
                            try { sockInstance.sendMessage(timer.chatId, { text: `♾️ Mugen! ${target.nome} anulou o ataque! (${target.mugen_charges} cargas restantes)` }); } catch {}
                            continue;
                        }
                        if (target.cla_id === 'hyuga' && Math.random() < (clas.find(c => c.id === 'hyuga')?.buff?.chance || 0.15)) {
                            try { sockInstance.sendMessage(timer.chatId, { text: `👁️ Byakugan! ${target.nome} desviou do ataque em área!` }); } catch {}
                            continue;
                        }
                        const iSI = target.habilidades?.indexOf('instinto_superior');
                        const cd_IS = target.cooldowns?.instinto_superior || 0;
                        if (iSI !== -1 && iSI !== undefined && now >= cd_IS) {
                            target.cooldowns.instinto_superior = now + (4 * 60 * 60 * 1000);
                            userDbChanged = true;
                            try { 
                                sockInstance.sendMessage(timer.chatId, { 
                                    text: `🌌 Instinto Superior! ${target.nome} desviou e anulou o ataque em área! (CD 4h)`,
                                    mentions: [denormalizeJid(uId)] 
                                }); 
                            } catch {}
                            continue;
                        }
                    }
                    // --- FIM DEFESAS ---
                    
                    let rouboIndividual = 0;
                    if (timer.skillId === 'bankai_senbonzakura') rouboIndividual = Math.floor(ouroAlvo * 0.20);
                    else if (timer.skillId === 'belzebu') rouboIndividual = Math.floor(ouroAlvo * 0.75);
                    else if (timer.skillId === 'respiracao_do_sol') rouboIndividual = Math.floor(ouroAlvo * 0.40);
                    else if (timer.skillId === 'estrondo') rouboIndividual = Math.floor(ouroAlvo * 0.50);
                    else if (timer.skillId === 'santuario_malevolente') rouboIndividual = Math.floor(ouroAlvo * 0.90);
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
                            // Limpa os payouts da pessoa resetada
                            if (payouts[uId]) {
                                delete payouts[uId];
                                payoutDbChanged = true; // Marca para salvar o payouts.json
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
                    await sockInstance.sendMessage(timer.chatId, { text: `${title}\n\n${msg}`, mentions: mencoes });
                } catch (e) { console.warn(`Erro msg ${timer.skillId}:`, e.message); }
                continue;
            }
            
            // --- HABILIDADES DE ALVO ÚNICO (A PARTE QUE FALTAVA - Bug 2) ---
            else {
                const target = usuarios[timer.targetId];
                if (!attacker || !target || !skill) { 
                    console.warn(`[SKILL] Atacante (${!!attacker}), Alvo (${!!target}) ou Skill (${!!skill}) nulo(s) para o timer ${timer.skillId}.`); 
                    continue; 
                }
                
                const is_unavoidable = timer.is_unavoidable || skill.is_unavoidable || false;

                // --- DEFESAS PASSIVAS (Alvo Único) ---
                if (skill.anime === 'Jujutsu Kaisen' && (target.buffs?.mahoraga_adapt || 0) > now) {
                    try { sockInstance.sendMessage(timer.chatId, { text: `☸️ ${target.nome} está adaptado! O ataque JJK foi anulado!` }); } catch {}
                    continue;
                }

                if (!is_unavoidable) {
                    // 1. Blut Vene
                    const bVI = target.habilidades?.indexOf('blut_vene');
                    if (bVI !== -1 && bVI !== undefined) {
                        target.habilidades.splice(bVI, 1);
                        userDbChanged = true;
                        try {
                            const aNum = getNum(timer.attackerId);
                            await sockInstance.sendMessage(timer.chatId, {
                                text: `🛡️ Blut Vene! ${target.nome} anulou @${aNum}!`,
                                mentions: [denormalizeJid(timer.attackerId), denormalizeJid(timer.targetId)],
                            });
                        } catch (e) {}
                        continue;
                    }
                    // 2. Mugen (Gojo)
                    if ((target.mugen_charges || 0) > 0) {
                        target.mugen_charges -= 1;
                        userDbChanged = true;
                        try {
                            const aNum = getNum(timer.attackerId);
                            await sockInstance.sendMessage(timer.chatId, { 
                                text: `♾️ Mugen! O ataque de @${aNum} contra ${target.nome} foi anulado! (${target.mugen_charges} cargas restantes)`,
                                mentions: [denormalizeJid(timer.attackerId), denormalizeJid(timer.targetId)],
                            }); 
                        } catch {}
                        continue;
                    }
                    // 3. Byakugan (Hyuga)
                    if (target.cla_id === 'hyuga' && Math.random() < (clas.find(c => c.id === 'hyuga')?.buff?.chance || 0.15)) {
                        try { await sockInstance.sendMessage(timer.chatId, { text: `👁️ Byakugan! ${target.nome} anulou!` }); } catch (e) {}
                        continue;
                    }
                    // 4. Instinto Superior (Sayajin)
                    const iSI = target.habilidades?.indexOf('instinto_superior');
                    const cd_IS = target.cooldowns?.instinto_superior || 0;
                    if (iSI !== -1 && iSI !== undefined && now >= cd_IS) {
                        // Aplica Cooldown no Instinto Superior
                        target.cooldowns.instinto_superior = now + (4 * 60 * 60 * 1000); // 4h CD
                        userDbChanged = true;
                        
                        try {
                            const aNum = getNum(timer.attackerId);
                            const tNum = getNum(timer.targetId);
                            await sockInstance.sendMessage(timer.chatId, {
                                text: `🌌 Instinto Superior! @${tNum} desviou e anulou o ataque de @${aNum}! (CD 4h)`,
                                mentions: [denormalizeJid(timer.attackerId), denormalizeJid(timer.targetId)],
                            });
                        } catch(e) {}
                        continue;
                    }
                }
                // --- FIM DEFESAS ---
                
                let oR = 0; // Ouro Roubado
                const tO = target.ouro || 0;
                const aO = attacker.ouro || 0;
                const multiplier = skill.multiplier || 1.0;
                
                // Lógica de Roubo (Alvo Único)
                if (timer.skillId === 'deathnote') oR = tO;
                else if (timer.skillId === 'mahito') oR = Math.floor(tO * 0.30);
                else if (timer.skillId === 'geass') oR = Math.floor(tO * 0.50);
                else if (timer.skillId === 'gate_of_babylon') oR = Math.floor(tO * (Math.random() * 0.35 + 0.05)); // 5% a 40%
                else if (timer.skillId === 'gomu_gomu_rocket') oR = Math.floor(tO * 0.15);
                else if (timer.skillId === 'mangekyou_inicial') oR = Math.floor(tO * 0.10);
                // (Adicione outras skills de alvo único aqui)
                
                target.ouro = tO - oR;
                attacker.ouro = aO + Math.round(oR * multiplier);
                userDbChanged = true;
                
                try {
                    const aNum = getNum(timer.attackerId);
                    const tNum = getNum(timer.targetId);
                    let msg = skill.msg_sucesso || `Efeito!`;
                    msg = msg.replace('{alvo}', tNum).replace('{atacante}', aNum).replace('{ouro_roubado}', fmt(oR));
                    await sockInstance.sendMessage(timer.chatId, {
                        text: `💀 Tempo acabou! 💀\n\n${msg}`,
                        mentions: [denormalizeJid(timer.attackerId), denormalizeJid(timer.targetId)],
                    });
                } catch (e) { console.warn(`Erro msg ${timer.skillId}:`, e.message); }
            }
        }
    }
    
    // (Item 6) Salva DBs se houveram mudanças
    if (timersDbChanged) {
        await saveDB(TIMERS_DB, timers);
    }
    if (userDbChanged) {
        await saveDB(USUARIOS_DB, usuarios);
    }
    if (payoutDbChanged) { // (Adicionado para correção do Madoka)
        await saveDB(PAYOUTS_DB, payouts);
    }
}