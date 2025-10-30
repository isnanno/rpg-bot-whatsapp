# WhatsApp RPG Bot

## Project Overview
This is a WhatsApp RPG bot (version 4.0) built with Node.js using the Baileys library. It provides a complete role-playing game experience within WhatsApp group chats, featuring clans, skills, economy system, and automated passive income mechanics.

## Current Status
- **Platform**: WhatsApp Bot (Console Application)
- **Language**: Node.js
- **Main Library**: @whiskeysockets/baileys v7.0.0-rc.6
- **Bot Version**: 4.0

## Project Structure
```
/
├── main.js                 # Main bot entry point
├── package.json            # Node.js dependencies
├── dados/                  # Database directory (JSON files)
│   ├── clas.json          # Clan definitions and buffs
│   ├── habilidades.json   # Skills/abilities configuration
│   ├── loja.json          # Shop items and passive income
│   ├── settings.json      # Bot settings (auto-created)
│   ├── timers.json        # Skill cooldown timers (auto-created)
│   ├── payouts.json       # Passive income timers (auto-created)
│   └── usuarios.json      # User data (auto-created)
└── midias/                # Media files (MP4/GIF for skills)
    ├── *.mp4              # Skill animations
    └── converter.py       # Utility to convert GIF to MP4
```

## Features
### Core Systems
1. **User Registration**: Players register with `.cadastro NAME`
2. **Clan System**: 14+ clans with unique buffs (Gojo, Uchiha, Saiyajin, etc.)
3. **Economy**: Gold-based economy with wallet and bank
4. **Skills System**: 
   - Consumable skills (bought from shop)
   - Clan skills (non-consumable with cooldowns)
   - Area-of-effect and single-target abilities
5. **Passive Income**: Anime-themed income items (15-minute intervals)
6. **Activities**: Manual gold-earning activities (.trabalhar, .minerar, .pescar, .crime, etc.)

### Technical Features
- **Reconnection Logic**: Exponential backoff (max 5 retries)
- **Persistence**: All timers and settings persist across restarts
- **QR Code Login**: Scan QR code to authenticate WhatsApp session
- **Group-Only**: Bot only responds in group chats

## Configuration
- **Bot Owner**: Configure `BOT_OWNER_JID` in main.js (line 35)
- **Prefix**: Commands use `.` prefix
- **Intervals**:
  - Passive Income: 15 minutes
  - Renda Loop Check: 15 seconds
  - Skill Timer Check: 1 second
  - Clan Cooldown Check: 1 minute

## Key Commands
- `.menu` - Main menu
- `.cadastro NAME` - Register as a new player
- `.loja SIGLA` - View shop category (e.g., `.loja jjk`)
- `.comprar ITEM` - Purchase an item
- `.habilidades CLA` - View clan abilities
- `.girarcla` - Re-roll clan (costs 1500 gold)
- `.banco` / `.carteira` - Check balances
- `.diario` - Daily bonus
- `.trabalhar` - Earn gold by working

## Authentication
On first run, the bot will:
1. Generate a QR code in the console
2. Scan the QR code with WhatsApp (Link Devices)
3. Session is saved in `auth_info_baileys/` directory
4. Subsequent runs auto-login using saved session

## User Preferences
- Bot is designed for anime RPG gaming in WhatsApp groups
- Uses JSON file persistence (no external database required)
- Media-rich interactions with skill animations

## Recent Changes (v4.0)
- Added reconnection with exponential backoff
- Persistent timers and payouts across restarts
- Settings database for toggles and daily discounts
- Clan cooldown loop for special abilities
- Improved JID normalization for database compatibility
- Added `.renda` toggle for passive income notifications

### Bug Fixes (October 30, 2025)
- **Fixed Clan Skills**: `.olhos_shinigami` and `.mangekyou_inicial` now properly use cooldowns instead of being consumed (added `is_clan_skill: true` and `cooldown_sec` to habilidades.json)
- **Fixed Store Abbreviations**: `.loja` command now supports siglas (e.g., `.loja jjk` works the same as `.loja jujutsu_kaisen`)
- **Fixed Skill Abbreviations**: `.habilidades` command now supports anime siglas (e.g., `.habilidades jjk`, `.habilidades jojo` work correctly)
- **Fixed Menu Display**: Both `.loja` and `.habilidades` now show category menus when used without arguments
- **Cleaned Menu**: Removed Commerce/Profile section from `.menugold` menu

## Development Notes
- All user data stored with normalized JIDs (@c.us format in DB)
- Baileys uses @s.whatsapp.net format for API calls
- Media fallback: tries MP4 first, then GIF, then text-only
- Bot owner can use `.add @user AMOUNT` to grant gold

## Important Files Not to Edit
- `auth_info_baileys/` - WhatsApp session data
- `dados/usuarios.json` - User progress data
- `dados/timers.json` - Active skill timers
- `dados/payouts.json` - Passive income tracking

## Running the Bot
The bot runs as a console application and maintains a persistent connection to WhatsApp. It will:
1. Connect to WhatsApp
2. Load all databases
3. Start passive income, skill timer, and clan cooldown loops
4. Listen for group messages with the `.` prefix
5. Auto-reconnect if disconnected (up to 5 attempts)

## Timezone
The bot uses Brazil timezone (America/Sao_Paulo) for daily bonuses and time-based features.
