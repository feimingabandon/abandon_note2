/**
 * cnlunar-js 工具拓展模块
 */

import { ENC_VECTOR_LIST, thingsSort } from '../data/config.js';

// 确保 rfRemove 是集合减法（A - B）
export function rfRemove(l = [], removeList = []) {
    const removeSet = new Set(removeList);
    return l.filter(item => !removeSet.has(item));
}

// 确保 rfAdd 是并集（A ∪ B）
export function rfAdd(l = [], addList = []) {
    return [...new Set([...l, ...addList])];
}

/**
 * 判断字符串是否非空且非空白字符
 * @param {string} s 
 * @returns {boolean}
 */
export function notEmpty(s) {
    return s && s.trim().length > 0;
}

/**
 * 两个数组合并对应元素相加或者相减
 * @param {Array} a 数组A
 * @param {Array} b 数组B，默认为节气偏移基准向量
 * @param {number} type 1 代表 a[i] + b[i]; -1 代表 a[i] - b[i]
 * @returns {Array} 合并后的数组
 */
export function abListMerge(a, b = ENC_VECTOR_LIST, type = 1) {
    if (a.length !== b.length) {
        console.warn('abListMerge: 两个数组长度不一致');
    }
    return a.map((val, i) => val + (b[i] || 0) * type);
}

/**
 * 宜忌事项的自定义排序函数
 * @param {string} x 待排序的事项名
 * @param {Array} sortList 排序参考基准，默认为 thingsSort
 * @returns {number} 排序权值 (索引)
 */
export function sortCollation(x, sortList = thingsSort) {
    const index = sortList.indexOf(x);
    if (index !== -1) {
        return index;
    } else {
        // 如果不在排序列表中，排在最后
        return sortList.length + 1;
    }
}

/**
 * 辅助方法：JS 版的 range 函数实现 (类似 Python range)
 * @param {number} start 
 * @param {number} stop 
 * @param {number} step 
 * @returns {Array}
 */
export function range(start, stop, step = 1) {
    if (stop === undefined) {
        stop = start;
        start = 0;
    }
    const result = [];
    for (let i = start; step > 0 ? i < stop : i > stop; i += step) {
        result.push(i);
    }
    return result;
}