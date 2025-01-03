/**
 * @param {number} timestamp - Timestamp to trim
 * @param {number} period - Period in seconds
 * @return {number}
 */
function trimTimestampTo(timestamp, period) {
    return Math.floor(timestamp / period) * period
}

module.exports = {trimTimestampTo}