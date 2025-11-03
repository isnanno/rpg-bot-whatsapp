# 🎮 ShiroBot

Bot de RPG baseado em animes para WhatsApp, inspirado na personagem Shiro de No Game No Life. Desenvolvido com Baileys v7.0, permite que jogadores participem de um sistema de RPG completo com economia, habilidades de animes, clãs, loja e muito mais.

## 📋 Índice

- [Características](#-características)
- [Requisitos](#-requisitos)
- [Instalação](#-instalação)
- [Configuração](#-configuração)
- [Estrutura de Dados](#-estrutura-de-dados)
- [Comandos](#-comandos)
- [Funcionalidades](#-funcionalidades)
- [Sistema de Clãs](#-sistema-de-clãs)
- [Sistema de Habilidades](#-sistema-de-habilidades)
- [Sistema Econômico](#-sistema-econômico)
- [Loops Automáticos](#-loops-automáticos)
- [Troubleshooting](#-troubleshooting)

## ✨ Características

- 🎮 Sistema completo de RPG com economia
- 👥 Sistema de clãs com habilidades especiais
- 🛡️ Sistema de habilidades baseadas em animes populares
- 💰 Sistema bancário com depósito, saque e transferências (PIX)
- 🛒 Loja categorizada por animes
- 💼 Atividades para ganhar ouro (trabalhar, minerar, pescar, caçar, etc.)
- 📊 Renda passiva com itens
- ⚔️ Sistema de batalhas e habilidades ofensivas/defensivas
- 🎁 Sistema de recompensas diárias
- 🔄 Sistema de cooldowns e timers
- 📱 Interface com mídias (vídeos/GIFs/imagens)
- 🛡️ Proteção contra rate limiting do WhatsApp

## 📦 Requisitos

- Node.js 16+ instalado
- NPM ou Yarn
- Conta WhatsApp (número de telefone)
- Conexão com internet

## 🚀 Instalação

1. Clone ou baixe este repositório
2. Instale as dependências:

```bash
npm install
```

3. Execute o ShiroBot:

```bash
node main.js
```

4. Escaneie o QR Code exibido no terminal com seu WhatsApp
5. Aguarde a conexão ser estabelecida

## ⚙️ Configuração

### Variáveis Importantes

No arquivo `main.js`, você pode configurar:

- `PREFIX`: Prefixo dos comandos (padrão: `.`)
- `BOT_OWNER_JID`: JID do dono do bot para comandos administrativos
- `DADOS_DIR`: Diretório dos arquivos de dados (padrão: `./dados`)
- `MIDIAS_DIR`: Diretório das mídias (padrão: `./midias`)
- `AUTH_DIR`: Diretório de autenticação do Baileys (padrão: `./auth_info_baileys`)

### Estrutura de Pastas

O ShiroBot criará automaticamente as seguintes pastas:

```
rpg-bot-whatsapp/
├── dados/              # Arquivos JSON de dados
│   ├── usuarios.json   # Dados dos jogadores
│   ├── loja.json       # Itens da loja
│   ├── habilidades.json # Habilidades disponíveis
│   ├── clas.json       # Clãs disponíveis
│   ├── payouts.json    # Timers de renda passiva
│   ├── timers.json     # Timers de habilidades ativas
│   └── settings.json   # Configurações gerais
├── midias/             # Vídeos, GIFs e imagens
└── auth_info_baileys/  # Dados de autenticação (criado automaticamente)
```

## 📁 Estrutura de Dados

### usuarios.json

Armazena informações de cada jogador:

```json
{
  "5528981124442@c.us": {
    "nome": "Nome do Jogador",
    "ouro": 1000,
    "bank": 5000,
    "cla": "Uchiha",
    "cla_id": "uchiha",
    "passivos": [],
    "habilidades": ["mangekyou_inicial"],
    "cooldowns": {},
    "job": null,
    "lastKnownChatId": "120363123456789@g.us"
  }
}
```

### loja.json

Estrutura categorizada de itens:

```json
{
  "categorias": {
    "naruto": {
      "nome": "Naruto",
      "itens": {
        "rasengan": {
          "nome": "Rasengan",
          "preco": 5000,
          "tipo": "habilidade",
          "gif_id": "rasengan"
        }
      }
    }
  }
}
```

### habilidades.json

Define habilidades com propriedades como:
- `nome`: Nome da habilidade
- `anime`: Anime de origem
- `preco`: Preço de compra
- `descricao`: Descrição da habilidade
- `uso`: Como usar
- `gif_id`: ID da mídia associada
- `duracao_seg`: Duração em segundos
- `msg_anular`: Mensagem para anular
- `msg_sucesso`: Mensagem de sucesso
- `cooldown_sec`: Cooldown em segundos
- `is_clan_skill`: Se é habilidade de clã

### clas.json

Array de clãs com:
- `id`: ID único do clã
- `nome`: Nome do clã
- `sigla`: Sigla abreviada
- `chance`: Chance de ser sorteado
- `buff`: Bônus inicial (ouro ou habilidade)

## 🎮 Comandos

### 👤 Comandos de Perfil

- `.cadastro NOME` - Realiza o cadastro inicial
- `.menu` - Exibe o menu do jogador
- `.nick NOVO_NOME` - Altera o nome
- `.carteira` - Mostra carteira e banco

### 💰 Comandos Econômicos

- `.menugold` - Menu de economia
- `.banco` - Ver saldo bancário
- `.depositar <valor|all>` - Deposita ouro no banco
- `.sacar <valor|all>` - Saca ouro do banco
- `.pix <valor|all> @usuario` - Transfere ouro para outro jogador
- `.trade <id> @usuario` - Troca de item

### 🛒 Comandos de Loja

- `.loja` - Lista todas as categorias
- `.loja <categoria>` - Mostra itens de uma categoria
- `.comprar <item_id>` - Compra um item

### ⚔️ Comandos de Habilidades

- `.habilidades` - Lista categorias de habilidades
- `.habilidades <categoria>` - Lista habilidades de uma categoria
- `.<nome_habilidade> @usuario` - Usa uma habilidade (se requer alvo)
- `.<nome_habilidade>` - Usa uma habilidade (se não requer alvo)

### 👑 Comandos de Clãs

- `.clas` - Mostra informações sobre clãs
- `.girarcla` - Troca de clã (custo: 1.500 Ouro)
- `.listarclas` - Lista todos os clãs disponíveis

### 💼 Comandos de Trabalho

- `.diario` - Recebe recompensa diária
- `.trabalhar` - Trabalha para ganhar ouro
- `.minerar` - Mina recursos
- `.pescar` - Pescaria
- `.caçar` - Caça animais
- `.explorar` - Explora áreas
- `.crime` - Comete crimes (com risco)
- `.forjar` - Forja itens
- `.fazerbolo` - Faz bolo

### 🛠️ Comandos de Configuração

- `.configurar` - Menu de configurações
- `.set` - Configura notificações de grupo
- `.renda` - Liga/desliga renda passiva
- `.pocoes` - Gerencia poções

### 🎁 Outros Comandos

- `.vender <id_habilidade>` - Vende uma habilidade
- `.add <valor> @usuario` - [ADM] Adiciona ouro (apenas dono)

### 📝 Notas

- Todos os comandos usam o prefixo `.` (ponto)
- Alguns comandos requerem mencionar usuários com `@`
- Habilidades podem ter cooldowns e durações
- Algumas habilidades podem ser anuladas com mensagens específicas

## 🎯 Funcionalidades

### Sistema de Cadastro

Ao usar `.cadastro`, o jogador:
- Recebe um nome
- Ganha um clã aleatório (com buffs especiais)
- Recebe ouro inicial (100 base + bônus do clã)
- Pode receber habilidades iniciais dependendo do clã

### Sistema Econômico

- **Carteira**: Ouro que você tem em mãos
- **Banco**: Ouro guardado (mais seguro)
- **PIX**: Transferência entre jogadores
- **Trade**: Troca de itens entre jogadores
- **Loja**: Compras de itens e habilidades

### Renda Passiva

Itens de renda passiva geram ouro automaticamente:
- Payout a cada 15 minutos
- Controlado em `payouts.json`
- Pode ser desligado com `.renda`

### Sistema de Trabalho

Atividades geram ouro com:
- Cooldowns específicos por atividade
- Riscos variáveis (ex: `.crime` pode dar multa)
- Multiplicadores de buff por clã

### Sistema de Habilidades

Habilidades podem:
- Roubar ouro de outros jogadores
- Ter períodos de anulação
- Afetar área ou alvos específicos
- Ter cooldowns e duração
- Ser passivas (defesa automática)
- Ser de clã (especiais do clã)

### Timers e Anulações

- Habilidades com duração criam timers
- Alvos podem anular com mensagens específicas
- Sistema de cooldowns para balanceamento

## 👥 Sistema de Clãs

### Clãs Especiais

Cada clã tem:
- **Nome e ID único**
- **Chance de sorteio** (raridade)
- **Buff inicial** (ouro extra ou habilidade)
- **Habilidades de clã** (especiais, só para membros)

### Exemplos de Buffs

- `gold_start`: Ouro inicial extra
- `skill_start`: Habilidade inicial gratuita

### Troca de Clã

- Use `.girarcla` para trocar
- Custo: 1.500 Ouro
- Novo clã é sorteado aleatoriamente

## ⚔️ Sistema de Habilidades

### Tipos de Habilidades

1. **Ofensivas**: Roubam ouro ou causam efeitos
2. **Defensivas**: Anulam ataques (passivas ou ativas)
3. **Área**: Afetam múltiplos alvos
4. **Informação**: Revelam dados (ex: saldo)
5. **Especiais**: Efeitos únicos (ex: ZA WARUDO)

### Animes Suportados

- Jujutsu Kaisen (JJK)
- One Piece (OP)
- Attack on Titan (AOT)
- Dragon Ball (DBZ)
- Demon Slayer (DS)
- Blue Lock (BL)
- Naruto
- Bleach
- Death Note (DN)
- Code Geass
- Fate
- JoJo's Bizarre Adventure
- E outros...

## 💰 Sistema Econômico

### Moeda

- **Ouro**: Moeda principal do jogo
- Armazenado em carteira ou banco
- Formato de números: 1.000, 10.000, 1.000.000

### Atividades de Ganho

1. **Diário**: Recompensa diária
2. **Trabalhar**: Ganho regular
3. **Minerar**: Mineração de recursos
4. **Pescar**: Pesca com recompensas
5. **Caçar**: Caça animais
6. **Explorar**: Exploração de áreas
7. **Crime**: Ganho alto mas com risco
8. **Forjar**: Criação de itens
9. **Fazerbolo**: Produção de bolo

### Renda Passiva

- Itens comprados geram ouro periodicamente
- Payout a cada 15 minutos (configurável)
- Pode ter múltiplos itens de renda

## 🔄 Loops Automáticos

O ShiroBot possui loops automáticos:

1. **Renda Loop** (15s): Processa renda passiva
2. **Skill Loop** (1s): Processa timers de habilidades
3. **Clan Loop** (60s): Processa cooldowns de clãs
4. **Daily Discount Loop** (1h): Verifica desconto diário da loja

## 🛡️ Proteções Implementadas

### Rate Limiting

- Sistema de retry com backoff exponencial
- Detecção automática de rate limits (429)
- Fila de mensagens durante rate limit
- Proteção contra spamming

### Tratamento de Erros

- Try/catch em operações críticas
- Fallbacks para conexões perdidas
- Logs detalhados de erros
- Recuperação automática de conexão

### Validações

- Validação de JID normalizado
- Verificação de grupos válidos
- Checagem de dados antes de processar
- Proteção contra comandos inválidos

## 🔧 Troubleshooting

### ShiroBot não conecta

1. Verifique se o QR Code foi escaneado
2. Delete a pasta `auth_info_baileys` e tente novamente
3. Verifique sua conexão com internet

### Erro "Não cadastrado"

1. Use `.cadastro NOME` primeiro
2. Verifique se está em um grupo
3. Verifique se o arquivo `usuarios.json` existe

### Erro ao usar habilidades

1. Verifique se você possui a habilidade (`.menu`)
2. Verifique o cooldown
3. Verifique se o alvo está no mesmo grupo
4. Verifique se a mídia existe em `midias/`

### Mídias não aparecem

1. Verifique se os arquivos existem em `midias/`
2. Formatos suportados: `.mp4`, `.gif`, `.jpg`
3. O ShiroBot mostrará avisos de mídias faltantes ao iniciar

### Rate Limit

O ShiroBot tem proteção automática, mas se persistir:
1. Aguarde alguns minutos
2. Reduza o uso de comandos
3. Verifique logs para mais detalhes

## 📝 Notas de Desenvolvimento

### Tecnologias

- **Baileys v7.0**: Biblioteca WhatsApp Web API
- **Node.js**: Runtime JavaScript
- **Pino**: Sistema de logging
- **QRCode Terminal**: QR Code no terminal

### Estrutura do Código

- `connectToWhatsApp()`: Inicializa conexão
- `handle*()`: Funções de processamento de comandos
- `loadDB()/saveDB()`: Gerenciamento de dados
- Loops automáticos: Processamento em background
- Sistema de timers: Gerenciamento de habilidades ativas

### Customização

Para adicionar novas habilidades:
1. Adicione em `dados/habilidades.json`
2. Adicione mídia correspondente em `midias/`
3. Reinicie o ShiroBot

Para adicionar novos clãs:
1. Adicione em `dados/clas.json`
2. Configure buffs e chances
3. Reinicie o ShiroBot

## 📄 Licença

ISC

## 👨‍💻 Autor

Desenvolvido para uso em grupos de WhatsApp com temática de RPG baseado em animes.

---

**Versão**: 4.0 (Baileys v7.0)

