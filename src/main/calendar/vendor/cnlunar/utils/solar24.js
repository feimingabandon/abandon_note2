/**
 * cnlunar-js 24节气解密模块
 */
import { SOLAR_TERMS_DATA_LIST, START_YEAR, ENC_VECTOR_LIST } from '../data/config.js';

function abListMerge(a, b = ENC_VECTOR_LIST, type = 1) {
    return a.map((val, i) => val + (b[i] || 0) * type);
}

/**
 * 解压缩16进制节气数据
 */
export function unZipSolarTermsList(data, rangeEndNum = 24, charCountLen = 2) {
    let bigData = typeof data === 'string' ? BigInt(data) : BigInt(data);
    const charCountLenBig = BigInt(charCountLen);
    const mask = (1n << charCountLenBig) - 1n;
    
    let list2 = [];
    for (let i = 1; i <= rangeEndNum; i++) {
        const rightShift = charCountLenBig * BigInt(rangeEndNum - i);
        const val = Number((bigData >> rightShift) & mask);
        list2.unshift(val);
    }
    
    return abListMerge(list2);
}

export function getTheYearAllSolarTermsList(year) {
    const index = year - START_YEAR;
    if (index < 0 || index >= SOLAR_TERMS_DATA_LIST.length) {
        throw new Error(`年份超出范围: ${year}。仅支持 ${START_YEAR} 到 ${START_YEAR + SOLAR_TERMS_DATA_LIST.length - 1}。`);
    }
    return unZipSolarTermsList(SOLAR_TERMS_DATA_LIST[index]);
}