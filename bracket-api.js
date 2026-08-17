
const DEFAULT_TIMEOUT = 1000;

/* HELPERS */

/**
 * check if an index represents an allowed bracket city day
 * @param {number} index bracket day index
 * @returns {boolean} whether the day at `index` is allowed for read/write
 */
function isIndexInValidRange(index) {
    return Number.isSafeInteger(index) &&
        0 <= index && index < 9999_99_99 &&
        !(2000_00_00 <= index && index < 2100_00_00);
}
/**
 * check if a value is allowed for writing to a bracket city day
 * @param {number} value the value to check
 * @returns whether `value` is allowed to be written
 */
function isValueInValidRange(value) {
    return Number.isSafeInteger(value) &&
        0 <= value && value < 2**48;
}
/**
 * index to date string
 * @param {number} index bracket day index
 * @returns {string} the index in date format
 */
function toDate(index) {
    if (!isIndexInValidRange(index))
        throw new TypeError(`bracket date index in invalid range! ${index}`);
    const str = index.toString().padStart(8,'0');
    let outStr = '';
    for (let i=0; i<str.length; i++) {
        outStr += str[i];
        if (i === 3 || i === 5) {
            outStr += '-';
        }
    }
    return outStr;
}

/* GET */

/**
 * get json data from day index
 * @param {number} index bracket day index
 * @returns {Promise} resolves to the puzzle's json data
 */
async function getJsonFromDay(index) {
    const dateStr = toDate(index);
    return await fetch('https://stats.bracket.city/stats/'+dateStr)
        .then(res => res.json())
        .catch(error => {
            return getJsonFromDay(index);
        })
}
/**
 * get value from day index
 * @param {number} index bracket day index
 * @returns {number} the value at the given day
 */
export async function getDayValue(index) {
    const json = await getJsonFromDay(index);
    console.assert(json.puzzleDate === toDate(index));
    return json.totalScore ?? 0;
}
/**
 * get bytes from day
 * @param {number} index brackey day index
 * @param {number} ignoreBytes bytes to ignore, negative for ending bytes
 * @returns {Promise<Uint8Array>} resolves to the bytes
 */
export async function getDayBytes(index, ignoreBytes=0) {
    if (Math.abs(ignoreBytes) > 6 || !Number.isInteger(ignoreBytes))
        throw new TypeError(`ignoring invalid num of bytes! ${ignoreBytes}`);
    let num = BigInt(await getDayValue(index));
    const out = new Uint8Array(6-Math.abs(ignoreBytes));
    if (ignoreBytes > 0) {
        num >>= BigInt(8*ignoreBytes);
    }
    for (let i=0; i<out.length; i++) {
        out[i] = Number(num >> BigInt(8*i));
    }
    return out;
}
/**
 * get a specified number of bytes from a given day index
 * @param {number} startIndex start day index
 * @param {number} length num of bytes to get
 * @param {number} byteOffset how many bytes to go before starting
 * @returns {Promise<Uint8Array>} resolves to the bytes at the location
 */
export async function getBytes(startIndex, length, byteOffset=0, timeout=DEFAULT_TIMEOUT) {
    if (byteOffset < 0)
        throw new TypeError(`byte offset can't be negative, if you rly want maybe i can implement it`);
    if (byteOffset % 6 > 0 && byteOffset + length < 6)
        throw new TypeError(`sorry! can't get bytes from just the middle of a day. try aligning this data with a day.`);

    startIndex += Math.floor(byteOffset / 6);
    byteOffset %= 6;
    const out = new Uint8Array(length);
    const numDays = Math.ceil((byteOffset+length)/6);
    let promises = [];
    const resolveds = [];
    for (let i=0; i<numDays; i++) {
        promises.push(getDayBytes(
            startIndex+i,
            i===0 ?
                byteOffset :
                i===numDays-1 ?
                    ((byteOffset+length-1)%6)-5 :
                    0
        ));
        if (i % 1000 === 0) {
            resolveds.push(...(await Promise.all(promises)));
            promises = [];
            await new Promise(res => setTimeout(res,timeout));
        }
    }
    resolveds.push(...(await Promise.all(promises)));
    for (let i=0; i<numDays; i++) {
        out.set(resolveds[i], 6*i-(i===0?0:byteOffset));
    }
    return out;
}

/* SET */

/**
 * set the total score for a bracket stat page
 * @param {number} index bracket day index
 * @param {number} value value to set
 * @param {number} ignoreBytes number of bytes to keep as the original day's, negative to ignore ending bytes
 * @returns {Promise} resolves to the JSON that the puzzle becomes
 */
export async function setDayValue(index, value, ignoreBytes=0) {
    if (!isValueInValidRange(value))
        throw new TypeError(`bracket setting value in invalid range! ${value}`);
    if (Math.abs(ignoreBytes) > 6 || !Number.isInteger(ignoreBytes))
        throw new TypeError(`ignoring invalid num of bytes! ${ignoreBytes}`);

    let keepNumMask = 0n;
    if (ignoreBytes) {
        if (ignoreBytes > 0) {
            for (let i=0; i<ignoreBytes; i++) {
                keepNumMask |= 0xffn << BigInt(8*i);
            }
        }
        else {
            for (let i=0; i<-ignoreBytes; i++) {
                keepNumMask |= (0xffn << BigInt(8*5)) >> BigInt(8*i);
            }
        }
    }

    if ((BigInt(value) & keepNumMask) !== 0n)
        throw new TypeError(`trying to set value with bits set in ignored range! 0x${value.toString(16).padStart(12,'0')} 0x${keepNumMask.toString(16).padStart(12,'0')}`);

    return await getDayValue(index)
        .then(async currentValue => {
            if (!Number.isFinite(currentValue))
                throw new TypeError(`MAJOR ISSUE! nonfinite value at bracket day ${toDate(index)} is ${currentValue}`)
            return fetch('https://stats.bracket.city/track', {
                method: 'post',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    puzzleDate: toDate(index),
                    score:
                        value - currentValue + (
                            isValueInValidRange(currentValue) ?
                                Number(BigInt(currentValue) & keepNumMask) :
                                0
                            )
                })
            }).catch(e => console.log(`TRACKING FAILED`, e));
        })
        .then(res => res.json());
}
/**
 * set a day based on bytes
 * @param {number} index bracket day index
 * @param {Uint8Array} bytes bytes to write
 * @param {boolean} writeToEnd control which side the bytes are written on
 * @returns {Promise} resolves to the json from the fetch
 */
export async function setDayBytes(index, bytes, writeToEnd=false) {
    if (bytes.length > 6)
        throw new TypeError(`writing too many bytes to 1 day! ${bytes.length}`);

    let numToWrite = 0n;
    for (let i=0; i<bytes.length; i++) {
        numToWrite |= BigInt(bytes[i]) << BigInt(8*i);
    }
    if (writeToEnd) {
        numToWrite <<= BigInt(8*(6-bytes.length))
    }
    return await setDayValue(index, Number(numToWrite), (writeToEnd ? 1 : -1) * (6 - bytes.length));
}
/**
 * set specified bytes to a given day index
 * @param {number} startIndex start day index
 * @param {Uint8Array} bytes bytes to get
 * @param {number} byteOffset how many bytes to go before starting
 */
export async function setBytes(startIndex, bytes, byteOffset=0, timeout=DEFAULT_TIMEOUT) {
    if (byteOffset < 0)
        throw new TypeError(`byte offset can't be negative, if you rly want maybe i can implement it`);
    if (byteOffset % 6 > 0 && byteOffset + bytes.length < 6)
        throw new TypeError(`sorry! can't set bytes from just the middle of a day. try aligning this data with a day.`);

    startIndex += Math.floor(byteOffset / 6);
    byteOffset %= 6;
    const numDays = Math.ceil((byteOffset+bytes.length)/6);
    let promises = [];
    for (let i=0; i<numDays; i++) {
        promises.push(setDayBytes(
            startIndex+i,
            bytes.slice(
                i===0 ?
                    0 :
                    6*i-byteOffset,
                i===numDays-1 ?
                    bytes.length :
                    6*i-byteOffset+6
            ),
            i===0
        ));
        if (i % 1000 === 0) {
            await Promise.all(promises);
            promises = [];
            await new Promise(res => setTimeout(res,timeout));
        }
    }
    await Promise.all(promises);
    return;
}
