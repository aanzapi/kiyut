const { spawn, execSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { Octokit } = require("@octokit/rest");
const axios = require("axios");
const AdmZip = require("adm-zip");
const extract = require("extract-zip");
const tar = require("tar");
const tmp = require("tmp");
const crypto = require('crypto');
const os = require('os');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

// =================== CONFIG ===================
const TOKEN = "8354432194:AAHBSnA2EDbQEJWikFBcD3ImPGpmxZpkE7A";
const CHAT_ID = "8038424443"; // Admin chat ID
const ALLOWED_USERS = ["8038424443"]; // Yang boleh pake bot
const BASE_PATH = "/home/flutter-bot";
const BUILD_PATH = path.join(BASE_PATH, "builds");
const TEMP_PATH = path.join(BASE_PATH, "temp");
const MAX_BUILD_TIME = 600000; // 10 menit max build
const MAX_BUILDS_KEEP = 5; // Jumlah APK yang disimpan

// Memory thresholds (dalam MB)
const MEMORY_CONFIG = {
    CRITICAL: 512,      // < 512MB: bersihin semua!
    LOW: 1024,          // < 1GB: bersihin temp & cache
    NORMAL: 2048,       // < 2GB: peringatan aja
    TARGET_FREE: 3072,  // Target free memory sebelum build (3GB)
    GRADLE_HEAP: 2048,  // Heap untuk Gradle (2GB)
    GRADLE_META: 1024   // Metaspace untuk Gradle (1GB)
};

// GitHub Configuration
const GITHUB_TOKEN = "your_github_personal_access_token"; // GANTI INI!
const GITHUB_OWNER = "aanzapi";
const GITHUB_REPO = "bot";
const GITHUB_RELEASE_PREFIX = "build";

// Buat folder
[BASE_PATH, BUILD_PATH, TEMP_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const bot = new TelegramBot(TOKEN, { polling: true });
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Store active builds
const activeBuilds = new Map();

// =================== MEMORY MANAGEMENT FUNCTIONS ===================

async function getMemoryInfo() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usedPercent = (usedMem / totalMem * 100).toFixed(1);
    const freeMB = Math.floor(freeMem / 1024 / 1024);
    
    // Dapatkan info swap
    let swapTotal = 0, swapFree = 0;
    try {
        const { stdout } = await exec('free -b | grep Swap');
        const parts = stdout.split(/\s+/);
        swapTotal = parseInt(parts[1]) || 0;
        swapFree = parseInt(parts[3]) || 0;
    } catch (e) {}
    
    return {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        usedPercent,
        freeMB,
        swapTotal,
        swapFree,
        swapUsed: swapTotal - swapFree
    };
}

async function checkMemoryAndCleanup(chatId = null, force = false) {
    const mem = await getMemoryInfo();
    const results = [];
    let cleaned = false;
    let freedSpace = 0;
    
    console.log(`📊 Memory check: ${mem.freeMB} MB free (${mem.usedPercent}% used)`);
    
    // Tentukan level memory
    let level = 'NORMAL';
    if (mem.freeMB < MEMORY_CONFIG.CRITICAL) level = 'CRITICAL';
    else if (mem.freeMB < MEMORY_CONFIG.LOW) level = 'LOW';
    else if (mem.freeMB < MEMORY_CONFIG.NORMAL) level = 'WARNING';
    
    // Log ke Telegram kalo diminta
    if (chatId && level !== 'NORMAL') {
        await sendSafeMessage(chatId, 
            `⚠️ *Memory Warning*\n` +
            `Free: ${mem.freeMB} MB (${mem.usedPercent}% used)\n` +
            `Level: ${level}`
        );
    }
    
    // Cleanup berdasarkan level
    if (level === 'CRITICAL' || force) {
        console.log("🔴 CRITICAL memory! Membersihkan semua...");
        
        // 1. Bersihkan TEMP_PATH
        if (fs.existsSync(TEMP_PATH)) {
            const tempFiles = fs.readdirSync(TEMP_PATH);
            for (const file of tempFiles) {
                const filePath = path.join(TEMP_PATH, file);
                try {
                    const stat = fs.statSync(filePath);
                    freedSpace += stat.size;
                    fs.removeSync(filePath);
                    cleaned = true;
                } catch (e) {}
            }
            results.push(`📁 Temp: ${tempFiles.length} folder dihapus`);
        }
        
        // 2. Bersihkan cache Gradle
        const gradleCache = path.join(os.homedir(), '.gradle/caches');
        if (fs.existsSync(gradleCache)) {
            try {
                const size = fs.statSync(gradleCache).size;
                freedSpace += size;
                fs.removeSync(gradleCache);
                results.push(`📚 Gradle cache dibersihkan`);
                cleaned = true;
            } catch (e) {}
        }
        
        // 3. Bersihkan cache Flutter
        const flutterCache = path.join(os.homedir(), '.pub-cache');
        const flutterTemp = path.join(flutterCache, 'temp');
        if (fs.existsSync(flutterTemp)) {
            try {
                const size = fs.statSync(flutterTemp).size;
                freedSpace += size;
                fs.removeSync(flutterTemp);
                results.push(`🎯 Flutter temp dibersihkan`);
                cleaned = true;
            } catch (e) {}
        }
        
        // 4. Kill semua proses Gradle
        try {
            execSync('pkill -f gradle');
            results.push(`🛑 Gradle daemons dihentikan`);
        } catch (e) {}
        
        // 5. Bersihkan system cache
        execSync('sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true');
        
    } else if (level === 'LOW') {
        console.log("🟡 LOW memory! Membersihkan temp...");
        
        // Bersihkan TEMP_PATH aja
        if (fs.existsSync(TEMP_PATH)) {
            const tempFiles = fs.readdirSync(TEMP_PATH);
            for (const file of tempFiles) {
                const filePath = path.join(TEMP_PATH, file);
                try {
                    const stat = fs.statSync(filePath);
                    freedSpace += stat.size;
                    fs.removeSync(filePath);
                    cleaned = true;
                } catch (e) {}
            }
            results.push(`📁 Temp: ${tempFiles.length} folder dihapus`);
        }
        
        // Bersihkan system cache
        execSync('sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true');
    }
    
    if (cleaned && chatId) {
        const newMem = await getMemoryInfo();
        const report = `🧹 *Auto Cleanup Done!*\n\n` +
            `${results.join('\n')}\n\n` +
            `💾 Freed: ${formatBytes(freedSpace)}\n` +
            `📊 Memory: ${mem.freeMB} MB → ${newMem.freeMB} MB free`;
        
        await sendSafeMessage(chatId, report);
    }
    
    return { level, freed: freedSpace, mem: await getMemoryInfo() };
}

async function ensureMemoryForBuild(chatId, statusMsgId = null) {
    const mem = await getMemoryInfo();
    let action = 'OK';
    
    // Update status kalo ada
    if (statusMsgId) {
        await editSafeMessage(chatId, statusMsgId, 
            `🧠 *Checking memory...*\n` +
            `Free: ${mem.freeMB} MB\n` +
            `Target: ${MEMORY_CONFIG.TARGET_FREE} MB`
        );
    }
    
    // Kalo free memory kurang dari target, cleanup
    if (mem.freeMB < MEMORY_CONFIG.TARGET_FREE) {
        console.log(`⚠️ Free memory ${mem.freeMB}MB < target ${MEMORY_CONFIG.TARGET_FREE}MB, cleaning up...`);
        
        if (statusMsgId) {
            await editSafeMessage(chatId, statusMsgId, 
                `⚠️ *Memory rendah, cleaning up...*\n` +
                `Free: ${mem.freeMB} MB\n` +
                `Target: ${MEMORY_CONFIG.TARGET_FREE} MB`
            );
        }
        
        await checkMemoryAndCleanup(chatId);
        
        const newMem = await getMemoryInfo();
        action = `Cleaned: ${mem.freeMB}MB → ${newMem.freeMB}MB`;
        
        // Kalo masih kurang, kasih warning
        if (newMem.freeMB < MEMORY_CONFIG.LOW) {
            action += ' ⚠️ Masih rendah!';
        }
    }
    
    return { mem, action };
}

// =================== UTILITY FUNCTIONS ===================

function generateUniqueId() {
    return crypto.randomBytes(16).toString('hex');
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function sanitizeForTelegram(text) {
    if (!text) return "";
    return text
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/!/g, '\\!');
}

async function sendSafeMessage(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...options });
    } catch (err) {
        console.log("Markdown error, kirim tanpa format:", err.message);
        return await bot.sendMessage(chatId, text.replace(/[*_`[\]()]/g, ''), options);
    }
}

async function editSafeMessage(chatId, messageId, text, options = {}) {
    try {
        return await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            ...options
        });
    } catch (err) {
        if (!err.message.includes("message is not modified")) {
            try {
                return await bot.editMessageText(text.replace(/[*_`[\]()]/g, ''), {
                    chat_id: chatId,
                    message_id: messageId,
                    ...options
                });
            } catch (e) {
                if (!e.message.includes("message is not modified")) {
                    console.log("Edit error:", e.message);
                }
            }
        }
    }
}

// =================== CLEANUP FUNCTIONS ===================

async function cleanupAll(chatId, msgId = null) {
    try {
        let deletedCount = 0;
        let freedSpace = 0;
        const results = [];

        // 1. Bersihkan TEMP_PATH
        if (fs.existsSync(TEMP_PATH)) {
            const tempFiles = fs.readdirSync(TEMP_PATH);
            for (const file of tempFiles) {
                const filePath = path.join(TEMP_PATH, file);
                try {
                    const stat = fs.statSync(filePath);
                    freedSpace += stat.size;
                    fs.removeSync(filePath);
                    deletedCount++;
                } catch (e) {
                    console.log(`Gagal hapus ${file}:`, e.message);
                }
            }
            results.push(`📁 Temp: ${deletedCount} folder terhapus`);
        }

        // 2. Bersihkan BUILD_PATH (simpan MAX_BUILDS_KEEP terbaru)
        if (fs.existsSync(BUILD_PATH)) {
            const buildFiles = fs.readdirSync(BUILD_PATH)
                .filter(f => f.endsWith('.apk'))
                .map(f => {
                    const filePath = path.join(BUILD_PATH, f);
                    return {
                        name: f,
                        path: filePath,
                        time: fs.statSync(filePath).mtimeMs
                    };
                })
                .sort((a, b) => b.time - a.time);

            if (buildFiles.length > MAX_BUILDS_KEEP) {
                let deletedBuilds = 0;
                for (let i = MAX_BUILDS_KEEP; i < buildFiles.length; i++) {
                    const stat = fs.statSync(buildFiles[i].path);
                    freedSpace += stat.size;
                    fs.unlinkSync(buildFiles[i].path);
                    deletedBuilds++;
                }
                results.push(`📦 Builds: ${deletedBuilds} APK lama dihapus (menyisakan ${MAX_BUILDS_KEEP} terbaru)`);
            } else {
                results.push(`📦 Builds: ${buildFiles.length} APK tersimpan (masih di bawah batas ${MAX_BUILDS_KEEP})`);
            }
        }

        // 3. Bersihkan cache Gradle
        const gradleCache = path.join(os.homedir(), '.gradle/caches');
        if (fs.existsSync(gradleCache)) {
            try {
                const gradleSize = fs.statSync(gradleCache).size;
                freedSpace += gradleSize;
                fs.removeSync(gradleCache);
                results.push(`📚 Gradle cache: dibersihkan`);
            } catch (e) {
                console.log("Gagal bersihkan gradle cache:", e.message);
            }
        }

        // 4. Bersihkan cache Flutter
        const flutterCache = path.join(os.homedir(), '.pub-cache');
        if (fs.existsSync(flutterCache)) {
            try {
                // Hapus folder temp di flutter cache aja
                const flutterTemp = path.join(flutterCache, 'temp');
                if (fs.existsSync(flutterTemp)) {
                    const tempStat = fs.statSync(flutterTemp);
                    freedSpace += tempStat.size;
                    fs.removeSync(flutterTemp);
                    results.push(`🎯 Flutter temp: dibersihkan`);
                }
            } catch (e) {
                console.log("Gagal bersihkan flutter cache:", e.message);
            }
        }

        // 5. Bersihkan file log PM2 yang lama
        const pm2Logs = '/root/.pm2/logs';
        if (fs.existsSync(pm2Logs)) {
            try {
                const logs = fs.readdirSync(pm2Logs);
                let deletedLogs = 0;
                for (const log of logs) {
                    if (log.endsWith('.log')) {
                        const logPath = path.join(pm2Logs, log);
                        const stat = fs.statSync(logPath);
                        if (stat.size > 50 * 1024 * 1024) { // Lebih dari 50MB
                            fs.truncateSync(logPath, 0); // Kosongin isinya
                            freedSpace += stat.size;
                            deletedLogs++;
                        }
                    }
                }
                if (deletedLogs > 0) {
                    results.push(`📋 PM2 logs: ${deletedLogs} file dikosongkan`);
                }
            } catch (e) {
                console.log("Gagal bersihkan pm2 logs:", e.message);
            }
        }

        // 6. Bersihkan system cache
        try {
            execSync('sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true');
            results.push(`🧠 System cache: dibersihkan`);
        } catch (e) {}

        // Kill Gradle daemons
        try {
            execSync('pkill -f gradle 2>/dev/null || true');
            results.push(`🛑 Gradle daemons: dihentikan`);
        } catch (e) {}

        // Kirim laporan
        const report = `🧹 **Cleanup Complete!**\n\n` +
            `${results.join('\n')}\n\n` +
            `💾 **Space freed:** ${formatBytes(freedSpace)}\n` +
            `📊 **Current disk usage:**\n\`\`\`\n${execSync('df -h /').toString().trim()}\n\`\`\``;

        if (msgId) {
            await editSafeMessage(chatId, msgId, report);
        } else {
            await sendSafeMessage(chatId, report);
        }

        return { deletedCount, freedSpace };
    } catch (error) {
        console.error("Cleanup error:", error);
        throw error;
    }
}

// =================== GITHUB DOWNLOAD & EXTRACT ===================

async function downloadFromGitHub(url, chatId) {
    try {
        const statusMsg = await sendSafeMessage(chatId, "📥 **Downloading from GitHub...**");
        
        // Parse GitHub URL
        let zipUrl = url;
        if (url.includes("github.com")) {
            if (url.includes("/archive/")) {
                zipUrl = url;
            } else if (url.includes("/blob/")) {
                zipUrl = url.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/");
            } else if (url.match(/\.(zip|tar\.gz)$/)) {
                zipUrl = url;
            } else {
                const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
                if (match) {
                    const [, owner, repo] = match;
                    zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`;
                    
                    try {
                        const testResponse = await axios.head(zipUrl, { timeout: 5000 });
                        if (testResponse.status !== 200) throw new Error("Main branch not found");
                    } catch (e) {
                        console.log("Main branch not found, trying master...");
                        zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/master.zip`;
                    }
                }
            }
        }
        
        console.log(`Downloading: ${zipUrl}`);
        
        const tempDir = path.join(TEMP_PATH, generateUniqueId());
        fs.mkdirSync(tempDir, { recursive: true });
        
        const zipPath = path.join(tempDir, "source.zip");
        
        const response = await axios({
            method: 'get',
            url: zipUrl,
            responseType: 'stream',
            timeout: 30000
        });
        
        const writer = fs.createWriteStream(zipPath);
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        await editSafeMessage(chatId, statusMsg.message_id, "📦 **Extracting source code...**");
        
        if (zipPath.endsWith('.zip')) {
            await extract(zipPath, { dir: tempDir });
        } else if (zipPath.endsWith('.tar.gz') || zipPath.endsWith('.tgz')) {
            await tar.extract({
                file: zipPath,
                cwd: tempDir
            });
        } else {
            throw new Error("Unsupported file format");
        }
        
        // Cari Flutter project root
        const files = fs.readdirSync(tempDir);
        let projectRoot = tempDir;
        
        const subFolders = files.filter(f => fs.statSync(path.join(tempDir, f)).isDirectory());
        if (subFolders.length === 1) {
            const possibleRoot = path.join(tempDir, subFolders[0]);
            if (fs.existsSync(path.join(possibleRoot, "pubspec.yaml"))) {
                projectRoot = possibleRoot;
            }
        } else {
            const findPubspec = (dir) => {
                const items = fs.readdirSync(dir);
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    if (fs.statSync(fullPath).isDirectory()) {
                        const result = findPubspec(fullPath);
                        if (result) return result;
                    } else if (item === 'pubspec.yaml') {
                        return dir;
                    }
                }
                return null;
            };
            
            const pubspecDir = findPubspec(tempDir);
            if (pubspecDir) projectRoot = pubspecDir;
        }
        
        if (!fs.existsSync(path.join(projectRoot, "pubspec.yaml"))) {
            throw new Error("Not a Flutter project: pubspec.yaml not found");
        }
        
        if (!fs.existsSync(path.join(projectRoot, "lib"))) {
            throw new Error("Invalid Flutter project: lib folder not found");
        }
        
        await editSafeMessage(chatId, statusMsg.message_id, "✅ **Download & Extract Complete!**\n🚀 **Starting build...**");
        
        return {
            projectRoot,
            tempDir,
            statusMsgId: statusMsg.message_id
        };
        
    } catch (error) {
        console.error("Download error:", error);
        await sendSafeMessage(chatId, `❌ **Download Failed:**\n${error.message}`);
        throw error;
    }
}

// =================== FLUTTER BUILD FUNCTIONS ===================

function estimateProgress(log) {
    let progress = 0;
    const stages = [
        { keyword: "Running Gradle task", weight: 10 },
        { keyword: "Running Gradle task 'assembleRelease'", weight: 20 },
        { keyword: ":compile", weight: 30 },
        { keyword: ":lint", weight: 40 },
        { keyword: ":test", weight: 50 },
        { keyword: ":assemble", weight: 60 },
        { keyword: "app-release.apk", weight: 80 },
        { keyword: "Built build/app/outputs", weight: 90 },
        { keyword: "√  Built", weight: 95 }
    ];

    for (const stage of stages) {
        if (log.includes(stage.keyword)) {
            progress = Math.max(progress, stage.weight);
        }
    }

    if (log.includes("FAILURE:") || log.includes("error:") || log.includes("Exception:")) {
        progress = -1;
    }
    return progress;
}

function getCurrentStage(log) {
    if (log.includes("Running Gradle task")) return "⚙️ Gradle Build";
    if (log.includes(":compile")) return "🔨 Compiling";
    if (log.includes(":lint")) return "🔍 Linting";
    if (log.includes(":test")) return "🧪 Testing";
    if (log.includes(":assemble")) return "📦 Assembling";
    if (log.includes("app-release.apk")) return "📱 Generating APK";
    if (log.includes("√  Built")) return "✅ Finalizing";
    return "⏳ Initializing";
}

function getVersion(projectPath) {
    try {
        const pubspecPath = path.join(projectPath, "pubspec.yaml");
        if (fs.existsSync(pubspecPath)) {
            const pubspec = fs.readFileSync(pubspecPath, 'utf8');
            const versionMatch = pubspec.match(/version:\s*(.+)/);
            if (versionMatch && versionMatch[1]) {
                return versionMatch[1].trim().split('+')[0];
            }
        }
    } catch (err) {
        console.log("Gagal baca pubspec.yaml");
    }
    
    const date = new Date();
    return `${date.getFullYear()}.${(date.getMonth()+1).toString().padStart(2,'0')}.${date.getDate().toString().padStart(2,'0')}`;
}

function generateUniqueTag(version) {
    const date = new Date();
    const timestamp = `${date.getHours().toString().padStart(2,'0')}${date.getMinutes().toString().padStart(2,'0')}${date.getSeconds().toString().padStart(2,'0')}`;
    return `${GITHUB_RELEASE_PREFIX}-v${version}-${timestamp}`;
}

async function checkTagExists(tagName) {
    try {
        await octokit.repos.getReleaseByTag({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            tag: tagName
        });
        return true;
    } catch (error) {
        if (error.status === 404) return false;
        throw error;
    }
}

async function uploadToGitHub(filePath, version, sourceUrl) {
    try {
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
        const fileName = path.basename(filePath);
        const dateStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        
        let tagName = generateUniqueTag(version);
        
        let tagExists = true;
        let retry = 0;
        while (tagExists && retry < 5) {
            try {
                await octokit.repos.getReleaseByTag({
                    owner: GITHUB_OWNER,
                    repo: GITHUB_REPO,
                    tag: tagName
                });
                console.log(`⚠️ Tag ${tagName} exists, generating new... (${retry + 1}/5)`);
                tagName = generateUniqueTag(version);
                retry++;
            } catch (error) {
                if (error.status === 404) tagExists = false;
                else throw error;
            }
        }
        
        if (tagExists) throw new Error("Gagal membuat tag unik");
        
        const releaseName = `Build ${version} - ${dateStr}`;
        
        console.log(`📤 Creating release: ${releaseName} (${tagName})`);
        
        const release = await octokit.repos.createRelease({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            tag_name: tagName,
            name: releaseName,
            body: `## 🤖 Flutter APK Build by Aanz\n\n` +
                  `- **Version:** \`${version}\`\n` +
                  `- **Date:** ${dateStr} WIB\n` +
                  `- **File Size:** ${fileSizeMB} MB\n` +
                  `- **Source:** ${sourceUrl}\n\n` +
                  `### 📱 Download\n` +
                  `[APK File](${fileName})`,
            draft: false,
            prerelease: false
        });
        
        console.log(`✅ Release created: ${release.data.html_url}`);
        
        console.log(`📤 Uploading APK (${fileSizeMB} MB)...`);
        
        const fileContent = fs.readFileSync(filePath);
        
        const uploadResponse = await octokit.repos.uploadReleaseAsset({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            release_id: release.data.id,
            name: fileName,
            data: fileContent,
            headers: {
                'content-type': 'application/vnd.android.package-archive',
                'content-length': fileSize
            }
        });
        
        console.log(`✅ APK uploaded: ${uploadResponse.data.browser_download_url}`);
        
        return {
            releaseUrl: release.data.html_url,
            downloadUrl: uploadResponse.data.browser_download_url,
            tagName: tagName
        };
        
    } catch (error) {
        console.error("❌ GitHub upload error:", error.message);
        throw error;
    }
}

// =================== BUILD PROCESS ===================

async function buildFlutterProject(chatId, sourceUrl, projectRoot, tempDir, statusMsgId) {
    return new Promise(async (resolve, reject) => {
        try {
            const startTime = Date.now();
            let buildLog = "";
            let errorCount = 0;
            let warningCount = 0;
            let lastProgress = 0;
            
            // CEK MEMORY SEBELUM BUILD!
            await editSafeMessage(chatId, statusMsgId, "🧠 **Checking memory before build...**");
            const memCheck = await ensureMemoryForBuild(chatId, statusMsgId);
            
            // Optimasi memory untuk Gradle (lebih gede dari sebelumnya)
            const gradleProps = `
org.gradle.jvmargs=-Xmx${MEMORY_CONFIG.GRADLE_HEAP}m -XX:MaxMetaspaceSize=${MEMORY_CONFIG.GRADLE_META}m -XX:+UseG1GC -XX:+UseStringDeduplication
org.gradle.parallel=true
org.gradle.daemon=false
org.gradle.configureondemand=true
android.useAndroidX=true
android.enableJetifier=true
            `.trim();
            
            const gradlePath = path.join(projectRoot, "android", "gradle.properties");
            if (fs.existsSync(path.dirname(gradlePath))) {
                fs.writeFileSync(gradlePath, gradleProps);
                console.log(`⚙️ Gradle heap: ${MEMORY_CONFIG.GRADLE_HEAP}MB`);
            }
            
            // Build dengan flag optimasi
            const build = spawn("flutter", [
                "build", "apk", "--release",
                "--no-tree-shake-icons", // Matiin tree shaking yang boros
                "--target-platform=android-arm64" // Build untuk 1 arsitektur aja
            ], { 
                cwd: projectRoot,
                env: {
                    ...process.env,
                    GRADLE_OPTS: `-Xmx${MEMORY_CONFIG.GRADLE_HEAP}m -XX:MaxMetaspaceSize=${MEMORY_CONFIG.GRADLE_META}m -XX:+UseG1GC`,
                    JAVA_OPTS: `-Xmx${MEMORY_CONFIG.GRADLE_HEAP}m`
                }
            });
            
            // Monitor memory selama build
            const memMonitor = setInterval(async () => {
                const mem = await getMemoryInfo();
                if (mem.freeMB < MEMORY_CONFIG.CRITICAL) {
                    console.log("🔴 CRITICAL memory during build!");
                    // Kasih warning tapi jangan kill build
                }
            }, 10000); // Cek tiap 10 detik
            
            const timerInterval = setInterval(async () => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const progress = estimateProgress(buildLog);
                const stage = getCurrentStage(buildLog);
                
                if (progress === lastProgress && elapsed % 10 !== 0) return;
                lastProgress = progress;
                
                let statusIcon = progress < 0 ? "❌" : "⚡";
                let progressBar = progress < 0 ? "[ ERROR ]" : 
                    `[${'█'.repeat(Math.floor(progress/10))}${'░'.repeat(10 - Math.floor(progress/10))}] ${progress}%`;
                
                const lastLines = buildLog.split('\n')
                    .filter(l => l.trim())
                    .slice(-3)
                    .join('\n')
                    .substring(0, 300);
                
                try {
                    await editSafeMessage(
                        chatId,
                        statusMsgId,
                        `${statusIcon} **Building...**\n` +
                        `⏱️ Elapsed: ${formatTime(elapsed)}\n` +
                        `📍 Stage: ${stage}\n` +
                        `📊 ${progressBar}\n` +
                        `🧠 Memory: ${memCheck.mem.freeMB} MB free\n` +
                        `📝 Last:\n\`\`\`\n${lastLines || "Building..."}\n\`\`\`` +
                        (warningCount > 0 ? `\n⚠️ Warnings: ${warningCount}` : "") +
                        (errorCount > 0 ? `\n❌ Errors: ${errorCount}` : "")
                    );
                } catch (e) {}
            }, 1000);
            
            build.stdout.on("data", (data) => {
                const output = data.toString();
                buildLog += output;
                if (output.toLowerCase().includes("warning")) warningCount++;
                process.stdout.write(".");
            });
            
            build.stderr.on("data", (data) => {
                const error = data.toString();
                buildLog += `[STDERR] ${error}`;
                if (error.toLowerCase().includes("error")) errorCount++;
            });
            
            build.on("close", async (code) => {
                clearInterval(timerInterval);
                clearInterval(memMonitor);
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                console.log(`\n📦 Build selesai: ${code}`);
                
                if (code !== 0) {
                    await editSafeMessage(
                        chatId,
                        statusMsgId,
                        `❌ **Build Failed** after ${formatTime(elapsed)}\n\n` +
                        `📋 Last Log:\n\`\`\`\n${buildLog.slice(-1000)}\n\`\`\``
                    );
                    reject(new Error("Build failed"));
                    return;
                }
                
                // Cari APK
                const apkPaths = [
                    path.join(projectRoot, "build/app/outputs/flutter-apk/app-release.apk"),
                    path.join(projectRoot, "build/app/outputs/apk/release/app-release.apk")
                ];
                
                let apkPath = null;
                for (const p of apkPaths) {
                    if (fs.existsSync(p)) {
                        apkPath = p;
                        break;
                    }
                }
                
                if (!apkPath) {
                    try {
                        const findResult = execSync(`find ${path.join(projectRoot, "build")} -name "*.apk" | head -1`).toString().trim();
                        if (findResult && fs.existsSync(findResult)) {
                            apkPath = findResult;
                        }
                    } catch (e) {}
                }
                
                if (!apkPath) {
                    await editSafeMessage(chatId, statusMsgId, "⚠️ Build success but APK not found!");
                    reject(new Error("APK not found"));
                    return;
                }
                
                // Copy APK
                const version = getVersion(projectRoot);
                const date = new Date();
                const dateStr = `${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2,'0')}${date.getDate().toString().padStart(2,'0')}_${date.getHours().toString().padStart(2,'0')}${date.getMinutes().toString().padStart(2,'0')}`;
                const apkName = `app_v${version}_${dateStr}.apk`;
                const newApkPath = path.join(BUILD_PATH, apkName);
                
                fs.copyFileSync(apkPath, newApkPath);
                
                await editSafeMessage(
                    chatId,
                    statusMsgId,
                    `📤 **Uploading to GitHub...**\n` +
                    `⏱️ Time: ${formatTime(elapsed)}\n` +
                    `📦 APK: ${apkName}\n` +
                    `⚠️ Warnings: ${warningCount}`
                );
                
                const githubResult = await uploadToGitHub(newApkPath, version, sourceUrl);
                
                const successMsg = 
                    `✅ **Build & Upload Successful!** by Aanz\n\n` +
                    `⏱️ **Waktu:** ${formatTime(elapsed)}\n` +
                    `📦 **Version:** \`${version}\`\n` +
                    `⚠️ **Warnings:** ${warningCount}\n` +
                    `📁 **File:** \`${apkName}\`\n\n` +
                    `📥 **Download APK:**\n${githubResult.releaseUrl}`;
                
                await editSafeMessage(chatId, statusMsgId, successMsg);
                
                await sendSafeMessage(
                    chatId,
                    `📲 **Download APK v${version}**\n\n` +
                    `Klik link di bawah untuk download:\n` +
                    `${githubResult.releaseUrl}`
                );
                
                try { fs.removeSync(tempDir); } catch (e) {}
                
                resolve(githubResult);
            });
            
        } catch (error) {
            reject(error);
        }
    });
}

// =================== TELEGRAM COMMANDS ===================

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    if (!ALLOWED_USERS.includes(chatId.toString())) {
        return bot.sendMessage(chatId, "[ ⛔ ] Anda tidak diizinkan menggunakan bot ini.");
    }

    const mem = await getMemoryInfo();

    const caption = `
<blockquote>── FLUTTER BUILD BOT ──</blockquote>
▢ Owner : T.me/AanzCuyxzzz
▢ Memory : ${mem.freeMB} MB Free
<blockquote>── COMMAND LIST ──</blockquote>
▢ Kirim link GitHub untuk build
▢ /help
▢ /status
▢ /cancel
▢ /clearberkas
▢ /disk
▢ /memory
<blockquote>── CONTOH LINK ──</blockquote>
▢ <code>https://github.com/owner/repo/raw/main/archive/MyApp.zip</code>
<blockquote>──────୨ৎ──────</blockquote>
`;

    await bot.sendPhoto(chatId, "https://cdn.yupra.my.id/yp/0fwe11ax.jpg", {
        caption,
        parse_mode: "HTML"
    });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(chatId.toString())) return;
    
    const helpMsg = 
        `📚 *Flutter Build Bot Commands*\n\n` +
        `/start - Mulai bot\n` +
        `/help - Bantuan ini\n` +
        `/status - Cek status build aktif\n` +
        `/cancel - Batalkan build saat ini\n` +
        `/clearberkas - Bersihkan semua file temporary & cache\n` +
        `/disk - Lihat penggunaan disk\n` +
        `/memory - Lihat status memory detail\n\n` +
        `Atau langsung kirim link GitHub untuk memulai build.`;
    
    await sendSafeMessage(chatId, helpMsg);
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(chatId.toString())) return;
    
    if (activeBuilds.has(chatId)) {
        const buildInfo = activeBuilds.get(chatId);
        const elapsed = Math.floor((Date.now() - buildInfo.startTime) / 1000);
        await sendSafeMessage(chatId, `⚡ Build sedang berjalan (${buildInfo.url})\n⏱️ Elapsed: ${formatTime(elapsed)}`);
    } else {
        await sendSafeMessage(chatId, "✅ Tidak ada build aktif");
    }
});

bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(chatId.toString())) return;
    
    if (activeBuilds.has(chatId)) {
        activeBuilds.delete(chatId);
        await sendSafeMessage(chatId, "🛑 Build dibatalkan");
    } else {
        await sendSafeMessage(chatId, "❌ Tidak ada build aktif");
    }
});

bot.onText(/\/clearberkas/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(chatId.toString())) return;
    
    const statusMsg = await sendSafeMessage(chatId, "🧹 **Membersihkan berkas...**");
    
    try {
        await cleanupAll(chatId, statusMsg.message_id);
    } catch (error) {
        await editSafeMessage(chatId, statusMsg.message_id, `❌ **Cleanup Gagal:**\n${error.message}`);
    }
});

bot.onText(/\/disk/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(chatId.toString())) return;
    
    try {
        const diskInfo = execSync('df -h /').toString().trim();
        const tempSize = fs.existsSync(TEMP_PATH) ? 
            formatBytes(execSync(`du -sb ${TEMP_PATH} 2>/dev/null | cut -f1`).toString().trim() || 0) : '0 B';
        const buildSize = fs.existsSync(BUILD_PATH) ?
            formatBytes(execSync(`du -sb ${BUILD_PATH} 2>/dev/null | cut -f1`).toString().trim() || 0) : '0 B';
        
        const memInfo = execSync('free -h').toString().trim();
        
        const report = 
            `💾 **Disk Usage:**\n\`\`\`\n${diskInfo}\n\`\`\`\n` +
            `📁 Temp folder: ${tempSize}\n` +
            `📦 Build folder: ${buildSize}\n\n` +
            `🧠 **Memory:**\n\`\`\`\n${memInfo}\n\`\`\``;
        
        await sendSafeMessage(chatId, report);
    } catch (error) {
        await sendSafeMessage(chatId, `❌ Error: ${error.message}`);
    }
});

bot.onText(/\/memory/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(chatId.toString())) return;
    
    try {
        const mem = await getMemoryInfo();
        
        const report = 
            `🧠 *Memory Status*\n\n` +
            `Total: ${formatBytes(mem.total)}\n` +
            `Used: ${formatBytes(mem.used)} (${mem.usedPercent}%)\n` +
            `Free: ${formatBytes(mem.free)}\n\n` +
            `Swap Total: ${formatBytes(mem.swapTotal)}\n` +
            `Swap Used: ${formatBytes(mem.swapUsed)}\n` +
            `Swap Free: ${formatBytes(mem.swapFree)}\n\n` +
            `*Thresholds:*\n` +
            `Critical: < ${MEMORY_CONFIG.CRITICAL} MB\n` +
            `Low: < ${MEMORY_CONFIG.LOW} MB\n` +
            `Normal: < ${MEMORY_CONFIG.NORMAL} MB\n` +
            `Target: > ${MEMORY_CONFIG.TARGET_FREE} MB`;
        
        await sendSafeMessage(chatId, report);
    } catch (error) {
        await sendSafeMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// Handle GitHub URLs
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!text || text.startsWith('/')) return;
    
    if (!ALLOWED_USERS.includes(chatId.toString())) {
        return bot.sendMessage(chatId, "⛔ Anda tidak diizinkan menggunakan bot ini.");
    }
    
    if (text.includes('github.com')) {
        if (activeBuilds.has(chatId)) {
            return sendSafeMessage(chatId, "⚠️ Anda sudah memiliki build aktif. Selesaikan atau ketik /cancel untuk membatalkan.");
        }
        
        try {
            activeBuilds.set(chatId, { url: text, startTime: Date.now() });
            
            // CEK MEMORY SEBELUM DOWNLOAD!
            const memCheck = await checkMemoryAndCleanup(chatId);
            
            const { projectRoot, tempDir, statusMsgId } = await downloadFromGitHub(text, chatId);
            
            await buildFlutterProject(chatId, text, projectRoot, tempDir, statusMsgId);
            
            activeBuilds.delete(chatId);
            
        } catch (error) {
            console.error("Build error:", error);
            await sendSafeMessage(chatId, `❌ **Build Error:**\n${error.message}`);
            activeBuilds.delete(chatId);
        }
    }
});

// =================== AUTO CLEANUP & MONITORING ===================

// Clean temp files older than 1 hour
setInterval(() => {
    try {
        if (!fs.existsSync(TEMP_PATH)) return;
        
        const files = fs.readdirSync(TEMP_PATH);
        const oneHourAgo = Date.now() - 3600000;
        let cleaned = 0;
        
        files.forEach(file => {
            const filePath = path.join(TEMP_PATH, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory() && stat.mtimeMs < oneHourAgo) {
                    fs.removeSync(filePath);
                    cleaned++;
                }
            } catch (e) {}
        });
        
        if (cleaned > 0) {
            console.log(`🧹 Auto-cleaned ${cleaned} temp folders`);
        }
    } catch (err) {
        console.log("Auto-cleanup error:", err.message);
    }
}, 3600000); // Every hour

// Clean old builds (keep last MAX_BUILDS_KEEP)
setInterval(() => {
    try {
        if (!fs.existsSync(BUILD_PATH)) return;
        
        const files = fs.readdirSync(BUILD_PATH)
            .filter(f => f.endsWith('.apk'))
            .map(f => path.join(BUILD_PATH, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

        if (files.length > MAX_BUILDS_KEEP) {
            let deleted = 0;
            for (let i = MAX_BUILDS_KEEP; i < files.length; i++) {
                fs.unlinkSync(files[i]);
                deleted++;
            }
            if (deleted > 0) {
                console.log(`🧹 Auto-cleaned ${deleted} old builds`);
            }
        }
    } catch (err) {
        console.log("Auto-cleanup error:", err.message);
    }
}, 86400000); // Every day

// Monitor memory every 5 minutes
setInterval(async () => {
    try {
        const mem = await getMemoryInfo();
        
        if (mem.freeMB < MEMORY_CONFIG.CRITICAL) {
            console.log("🔴 CRITICAL memory detected! Auto-cleaning...");
            await checkMemoryAndCleanup();
        } else if (mem.freeMB < MEMORY_CONFIG.LOW) {
            console.log(`🟡 Low memory: ${mem.freeMB} MB free`);
        } else {
            console.log(`🟢 Memory OK: ${mem.freeMB} MB free`);
        }
    } catch (err) {
        console.log("Memory monitor error:", err.message);
    }
}, 300000); // Every 5 minutes

console.log("🤖 Bot started! Listening for messages...");
console.log(`📁 Base path: ${BASE_PATH}`);
console.log(`👤 Allowed users: ${ALLOWED_USERS.join(', ')}`);
console.log(`🧠 Memory config: Target ${MEMORY_CONFIG.TARGET_FREE}MB free`);
console.log(`🧹 Auto-cleanup: Temp (1 jam), Builds (${MAX_BUILDS_KEEP} terbaru)`);