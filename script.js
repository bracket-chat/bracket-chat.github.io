
/**

@TODO
* voting for resetting msgs and stuff(?)

// p@ssw0rd

*/

let playerId = -1;
const playerCount = 8;
// BYTE indices
const lockIndex = 0*4;
const playerDataStart = 1*4;
const playerDataSize = 17*4;
const playerColorOffset = 0*4;
const playerNameOffset = 1*4;
const playerPassHashOffset = 9*4;

const msgStartIndex = playerDataStart + playerDataSize * playerCount;
let msgReadingIndex = 0;

let players = [];
let msgs = [];

let loadingThingsTimeout = -1;

class Player {
    constructor(id) {
        this.id = id;
    }
    load() {
        const player = this;
        return new Promise(resolve => {
            getUserColor(this.id).then(color => {
                player.color = color;
                if (player.name) resolve(player);
            });
            getUserName(this.id).then(name => {
                player.name = name;
                if (player.color) resolve(player);
            });
        });
    }
}

class Message {
    constructor(bytes) {
        if (bytes.length < 2) {
            this.msg = null;
            return;
        }
        this.msg = '';
        this.user = bytes[0];
        this.type = bytes[1];
        for (let i=2; i<bytes.length; i++) {
            if (bytes[i] === 0) break;
            this.msg += String.fromCharCode(bytes[i]);
        }
    }
    toString() {
        return this.msg;
    }
    draw() {
        const msg = this;
        const player = players.find(player => player.id === msg.user);
        
        const li = document.createElement('li');
        document.getElementById('msgs').appendChild(li);
        const nameElem = document.createElement('span');
        nameElem.textContent = player === undefined ? '(not signed in)' : player.name;
        nameElem.style.color = player === undefined ? 'gray' : player.color;
        const msgElem = document.createElement('span');
        msgElem.textContent = msg.msg;

        li.append('[',nameElem,'] ',msgElem);
    }
}

function dayIndexToDate(dayIndex) {
    return new Date(Date.UTC(4000,0,1+dayIndex));
}

function dayIndexToDayString(dayIndex) {
    return dayIndexToDate(dayIndex).toJSON().split('T')[0];
}

async function readFromDay(dayIndex) {
    const dateStr = dayIndexToDayString(dayIndex);
    const url = 'https://stats.bracket.city/stats/'+dateStr;
    const json = await fetch(url).then(response => {
        if (!response.ok) {
            alert(`fetch error reading! ${dateStr}! retrying...`);
            setTimeout(() => readFromDay(dayIndex));
            return;
        }
        return response.json();
    });
    return json.totalScore ?? 0;
}

async function writeToDay(dayIndex, num, ignoreBytes) {
    return new Promise(resolve => {
        const date = dayIndexToDate(dayIndex);
        const dateStr = dayIndexToDayString(dayIndex);
        if (date.getTime() > Date.UTC(5000,0,0) ||
            date.getTime() < Date.UTC(4000,0,1)) {
            alert(`date is not in good range! ${dateStr} aborting`);
            return;
        }
        if (num % 1 !== 0 || num < 0 || num > 2**32) {
            alert(`writing num out of good range! ${dateStr} ${num} aborting`);
            return;
        }
        const url = 'https://stats.bracket.city/stats/'+dateStr;
        fetch(url).then(response => {
            if (!response.ok) {
                alert(`fetch error writing! ${dateStr}! retrying...`);
                setTimeout(() => resolve(writeToDay(dayIndex, num)), 1000);
                return;
            }
            return response.json();
        })
        .then(json => {
            if (json === undefined) return;
            console.assert(json.puzzleDate === dateStr);
            let numToSubtract = json.totalScore ?? 0;
            if (ignoreBytes && numToSubtract % 1 === 0) {
                let mask = 0n;
                for (let i=0; i<ignoreBytes; i++) {
                    mask |= 0xffn << BigInt(i*8);
                }
                mask = ~mask;
                mask &= 0xffffffffn;
                numToSubtract = Number(BigInt(numToSubtract) & mask);
            }
            fetch('https://stats.bracket.city/track', {
                method: 'post',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    puzzleDate: dateStr,
                    score: num - numToSubtract
                })
            })
            .then(response => response.json())
            .then(json => {
                if ((json.stats.totalScore !== num && !ignoreBytes) || json.stats.totalScore % 1 !== 0) {
                    alert(`total score not set to num! ${dateStr} ${json.stats.totalScore} ${num} retrying...`);
                    setTimeout(() => resolve(writeToDay(dayIndex, num, ignoreBytes)), 1000);
                    return;
                }
                resolve(dateStr);
            });
        });
    });
}

async function writeBytesTo(byteIndex, bytes) {
    return new Promise(resolve => {
        let dayIndex = Math.floor(byteIndex/4);
        let loopIndex = 0;
        let completedDayIndex = dayIndex;
        while (loopIndex<bytes.length) {
            let num = 0n;
            const startingJ = loopIndex === 0 ? byteIndex%4 : 0;
            for (let j=startingJ; j<4; j++) {
                num |= BigInt(bytes[loopIndex++]) << BigInt(j*8);
                if (loopIndex >= bytes.length) break;
            }
            writeToDay(dayIndex++, Number(num), startingJ).then(() => {
                completedDayIndex++;
                if (completedDayIndex >= dayIndex) {
                    resolve(bytes);
                }
            });
        }
    });
}

async function writeString(type, str) {
    if (!(await takeLock())) {
        return false;
    }
    let arr = new Uint8Array(str.length+4);
    arr[0] = playerId;
    arr[1] = type;
    for (let i=0; i<str.length; i++) {
        arr[i+2] = str.charCodeAt(i);
    }
    await writeBytesTo(msgStartIndex + msgReadingIndex, arr);
    const msg = new Message(arr);
    msgs.push(msg);
    msg.draw();
    msgReadingIndex += arr.length-1;
    await releaseLock();
    return msg;
}

async function readFixedBytes(startByte, byteCount) {
    return new Promise(resolve => {
        let doneBytes = 0;
        let arr = [];
        const startingDay = Math.floor(startByte/4);
        outerLoop:
        for (let i=0; i < (byteCount+(startByte%4))/4; i++) {
            readFromDay(startingDay+i).then(num => {
                const startingJ = i===0 ? startByte % 4 : 0;
                for (let j=startingJ; j<4; j++) {
                    const nextByte = Number((BigInt(num) & (0xffn << BigInt(j*8))) >> BigInt(j*8));
                    arr[i*4+j] = nextByte;
                    doneBytes++;
                    if (doneBytes >= byteCount) {
                        resolve(new Uint8Array(arr));
                        break;
                    }
                }
            });
        }
    });
}

async function readBytesUpToNullByte() {
    let arr = [];
    const startingDay = Math.floor((msgStartIndex + msgReadingIndex)/4);
    outerLoop:
    for (let i=0; true; i++) {
        const num = await readFromDay(startingDay+i);
        const startingJ = i===0 ? (msgStartIndex + msgReadingIndex) % 4 : 0;
        for (let j=startingJ; j<4; j++) {
            const nextByte = Number((BigInt(num) & (0xffn << BigInt(j*8))) >> BigInt(j*8));
            if (nextByte === 0) break outerLoop;
            arr.push(nextByte);
        }
    }
    if (arr.length > 0) msgReadingIndex += arr.length+1;
    return new Uint8Array(arr);
}

async function readString() {
    const bytes = await readBytesUpToNullByte();
    return new Message(bytes);
}

async function getPasswordHash(password) {
    const passwordBytes = await new Blob([password]).bytes();
    const hash = await crypto.subtle.digest('sha-256', passwordBytes);
    return new Uint8Array(hash);
}

async function setUserPassword(newPassword, user) {
    newPassword ??= '';
    user ??= playerId;
    if (user < 1 || user > playerCount) {
        alert(`invalid player! ${user}`);
        return;
    }
    const hashBytes = await getPasswordHash(newPassword);
    writeBytesTo(playerDataStart + playerDataSize*(user-1) + playerPassHashOffset, hashBytes);
}

async function checkPassword(password, user) {
    user ??= playerId;
    if (user < 1 || user > playerCount) {
        alert(`invalid player! ${user}`);
        return;
    }
    const hashBytes = await getPasswordHash(password);
    const serverHash = await readFixedBytes(playerDataStart + playerDataSize*(user-1) + playerPassHashOffset, 32);
    for (let i=0; i<32; i++) {
        if (hashBytes[i] !== serverHash[i]) return false;
    }
    return true;
}

async function setUserName(name, user) {
    user ??= playerId;
    if (user < 1 || user > playerCount) {
        alert(`invalid player! ${user}`);
        return;
    }
    if (name.length > 32) {
        alert(`trying to set name too big! ${name} ${name.length}`);
        return;
    }
    const bytes = new Uint8Array(32);
    for (let i=0; i<name.length; i++) {
        bytes[i] = name.charCodeAt(i);
    }
    players.find(player => player.id === user).name = name;
    await writeBytesTo(playerDataStart + playerDataSize*(user-1) + playerNameOffset, bytes);
    redraw();
    return name;
}

async function getUserName(user) {
    user ??= playerId;
    if (user < 1 || user > playerCount) {
        alert(`invalid player! ${user}`);
        return;
    }
    const bytes = await readFixedBytes(playerDataStart + playerDataSize*(user-1) + playerNameOffset, 32);
    let out = '';
    for (let i=0; i<bytes.length; i++) {
        if (bytes[i] === 0) break;
        out += String.fromCharCode(bytes[i]);
    }
    return out;
}

async function setUserColor(newColor, user) {
    user ??= playerId;
    if (user < 1 || user > playerCount) {
        alert(`invalid player! ${user}`);
        return;
    }
    const input = document.createElement('input');
    input.type = 'color';
    input.value = newColor;
    const str = input.value.substring(1);
    const bytes = new Uint8Array(4);
    for (let i=0; i<3; i++) {
        bytes[i] = parseInt(str.substring(i*2,i*2+2),16);
    }
    players.find(player => player.id === user).color = input.value;
    await writeBytesTo(playerDataStart + playerDataSize*(user-1) + playerColorOffset, bytes);
    redraw();
    return input.value;
}

async function getUserColor(user) {
    user ??= playerId;
    if (user < 1 || user > playerCount) {
        alert(`invalid player! ${user}`);
        return;
    }
    let str = '#';
    const bytes = await readFixedBytes(playerDataStart + playerDataSize*(user-1) + playerColorOffset, 4);
    for (let i=0; i<3; i++) {
        str += bytes[i].toString(16).padStart(2,0);
    }
    return str;
}

async function loadPlayerData() {
    const lock = await queryLock();

    drawLock(lock);

    if (lock.locked) {
        return new Promise(resolve => {
            setTimeout(() => resolve(loadPlayerData()), 1000);
        });
    }

    return new Promise(resolve => {
        players = [];
        let loadedPlayers = 0;
        for (let i=0; i<playerCount; i++) {
            new Player(i+1).load().then(player => {
                players.push(player);

                if (++loadedPlayers >= playerCount) {
                    players.sort((a,b) => a.id - b.id);

                    drawPlayers();

                    resolve();
                }
            });
        }
    });
}

async function loadAllMessages() {
    const lock = await queryLock();

    drawLock(lock);

    if (lock.locked) {
        return new Promise(resolve => {
            setTimeout(() => resolve(loadAllMessages()), 1000);
        });
    }

    msgs = [];
    msgReadingIndex = 0;
    document.getElementById('msgs').textContent = '';
    return await loadNextMessages();
}

async function loadNextMessages() {
    const lock = await queryLock();

    drawLock(lock);

    if (lock.locked) {
        return new Promise(resolve => {
            setTimeout(() => resolve(loadNextMessages()), 1000);
        });
    }

    document.getElementById('loading-msgs').style.visibility = 'visible';

    const msg = await readString();
    if (msg.msg === null) {
        document.getElementById('loading-msgs').style.visibility = 'hidden';
        return;
    }
    msgs.push(msg);
    msg.draw();
    await loadNextMessages();
}

function drawPlayers() {
    const ul = document.getElementById('users');
    ul.textContent = '';
    players.forEach(player => {
        const li = document.createElement('li');
        ul.appendChild(li);
        const span = document.createElement('span');
        span.textContent = player.name;
        span.style.color = player.color;
        const button = document.createElement('button');
        button.textContent = 'sign in';
        button.onclick = () => signIn(player.id);
        li.append(span, ' ', button);
    });
}

function drawSignedInAs() {
    const signedInAsSpan = document.getElementById('signed-in-as');
    const player = players.find(player => player.id === playerId);
    signedInAsSpan.textContent = player?.name ?? '(not signed in)';
    signedInAsSpan.style.color = player?.color ?? 'gray';
}

function redraw() {
    document.getElementById('msgs').textContent = '';
    msgs.forEach(msg => msg.draw());
    drawPlayers();
    drawSignedInAs();
}

async function clearMessages() {
    if (!confirm(`you are about to reset the whole chat! continue?`)) return;
    await writeBytesTo(msgStartIndex, new Uint8Array(2));
    msgs = [];
    msgReadingIndex = 0;
    document.getElementById('msgs').textContent = '';
}

async function resetUsers() {
    return new Promise(resolve => {
        if (!confirm(`you are about to reset all the user data! continue?`)) {
            resolve(false);
            return;
        }
        let doneNames = 0;
        let doneCols = 0;
        let donePasses = 0;
        function tryResolve() {
            if (doneNames >= playerCount && doneCols >= playerCount && donePasses >= playerCount) {
                resolve(true);
            }
        }
        for (let i=0; i<playerCount; i++) {
            setUserName(`User ${i+1}`, i+1).then(() => { doneNames++; tryResolve(); });
            setUserColor(`hsl(${360*i/playerCount} 100% 50%)`, i+1).then(() => { doneCols++; tryResolve(); });
            setUserPassword('', i+1).then(() => { donePasses++; tryResolve(); });
        }
        setTimeout(async () => { await loadPlayerData(); await loadAllMessages(); }, 1000)
    });
}

async function signIn(id) {
    const inputtedPass = prompt(`signing in as player ${id}: ${players.find(player => player.id === id).name}\npassword?`);
    const isCorrect = await checkPassword(inputtedPass, id);
    if (isCorrect) {
        playerId = id;
        drawSignedInAs();
        document.getElementById('change-pass').disabled = false;
        document.getElementById('change-name').disabled = false;
        document.getElementById('change-col').disabled = false;
        localStorage.setItem('bracket-chat-signed-in-as', playerId);
    }
    else {
        alert(`wrong password!`);
        localStorage.setItem('bracket-chat-signed-in-as', playerId);
    }
}

function signOut() {
    playerId = -1;
    drawSignedInAs();
    document.getElementById('change-pass').disabled = true;
    document.getElementById('change-name').disabled = true;
    document.getElementById('change-col').disabled = true;
    localStorage.setItem('bracket-chat-signed-in-as', playerId);
}

async function takeLock(id, force) {
    id ??= playerId;
    force ??= false;
    const lockData = await queryLock();
    if (lockData.locked && !force) {
        const minutesStr = minutesToString(lockData.minutesSince);
        alert(`writing lock has been taken by player ${lockData.player?.id} (${lockData.player?.name}) for ${minutesStr}. if this is too long then ask me to fix it. aborting...`);
        return false;
    }
    const bytesToWrite = new Uint8Array(4);
    bytesToWrite[0] = id;
    const currentMinute = Math.floor(Date.now()/1000/60);
    for (let i=0; i<3; i++) {
        bytesToWrite[i+1] = currentMinute >> (i*8);
    }
    await writeBytesTo(lockIndex, bytesToWrite);
    return true;
}

async function queryLock() {
    const lockData = await readFixedBytes(lockIndex, 4);
    const lockingPlayer = lockData[0];
    const currentMinute = Math.floor(Date.now()/1000/60);
    let lockTimestamp = 0;
    for (let i=0; i<3; i++) {
        lockTimestamp |= lockData[i+1] << (i*8);
    }
    while (currentMinute - lockTimestamp >= 1<<24) {
        lockTimestamp += 1<<24;
    }
    if (lockingPlayer !== 0) {
        const lockingPlayerObj = players.find(player => player.id === lockingPlayer);
        return {
            locked: true,
            player: lockingPlayerObj,
            timestamp: lockTimestamp,
            minutesSince: currentMinute - lockTimestamp
        };
    }
    return {
        locked: false,
        player: null,
        timestamp: lockTimestamp,
        minutesSince: currentMinute - lockTimestamp
    };
}

async function releaseLock() {
    await writeBytesTo(lockIndex, new Uint8Array(1));
    return true;
}

function drawLock(lock) {
    document.getElementById('lock').style.visibility = lock.locked ? 'visible' : 'hidden';
    if (lock.locked) {
        document.getElementById('locked-by').textContent = lock.player?.name ?? '(not signed in)';
        document.getElementById('locked-by').style.color = lock.player?.color ?? 'gray';
    }
}

function minutesToString(minutes) {
    let s = '';
    let hours = Math.floor(minutes/60);
    s += hours.toString() + 'h ';
    minutes -= hours*60;
    s += minutes.toString() + 'm';
    return s;
}

async function loadNewThings() {
    await loadNextMessages();
    loadingThingsTimeout = setTimeout(loadNewThings, 1000);
}

onload = async () => {
    await loadPlayerData();

    drawSignedInAs();

    document.getElementsByTagName('textarea')[0].onkeydown = e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const text = document.getElementsByTagName('textarea')[0].value;
            document.getElementsByTagName('textarea')[0].value = '';
            writeString(1, text);
        }
    }
    document.getElementById('go').onclick = () => {
        const text = document.getElementsByTagName('textarea')[0].value;
        document.getElementsByTagName('textarea')[0].value = '';
        writeString(1, text);
    }

    document.getElementById('sign-out').onclick = () => signOut();

    document.getElementById('change-pass').onclick = async () => {
        const oldPass = prompt('old password?');
        if (await checkPassword(oldPass)) {
            setUserPassword(prompt('new password?'));
        }
        else {
            alert('wrong password');
        }
    }
    document.getElementById('change-name').onclick = async () => {
        setUserName(prompt('new username?'));
    }
    document.getElementById('change-col').onclick = async () => {
        setUserColor(prompt('new color?'));
    }

    document.getElementById('reload-users').onclick = () => {
        loadPlayerData();
    }
    document.getElementById('reload-msgs').onclick = async () => {
        clearTimeout(loadingThingsTimeout);
        setTimeout(async () => {
            await loadAllMessages();
            loadingThingsTimeout = setTimeout(loadNewThings, 1000);
        }, 500);
    }

    const signedInAs = parseInt(localStorage.getItem('bracket-chat-signed-in-as'));
    if (signedInAs !== NaN && signedInAs !== -1) {
        signIn(signedInAs);
    }

    await loadAllMessages();

    loadingThingsTimeout = setTimeout(loadNewThings, 1000);
}
