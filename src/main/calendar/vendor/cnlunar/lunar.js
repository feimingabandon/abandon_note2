import { CivilDate as Date } from './civil-date.js';
/**
 * cnlunar-js 核心模块
 */
import {
    START_YEAR, lunarMonthData, lunarNewYearList, the10HeavenlyStems,
    the12EarthlyBranches, chineseZodiacNameList, SOLAR_TERMS_NAME_LIST,
    weekDay, the60HeavenlyEarth, lunarMonthNameList, lunarDayNameList,
    upperNum, theHalf60HeavenlyEarth5ElementsList, the28StarsList,
    pengTatooList, chinese12DayOfficers, chinese12DayGods,
    directionList, chinese8Trigrams, luckyGodDirection, wealthGodDirection,
    mascotGodDirection, sunNobleDirection, moonNobleDirection,
    fetalGodList, meridiansName, STAR_ZODIAC_NAME, STAR_ZODIAC_DATE,
    EAST_ZODIAC_LIST, the10HeavenlyStems5ElementsList,
    the12EarthlyBranches5ElementsList, officerThings, day8CharThing,
    bujiang, thingsSort, twohourLuckyTimeList
} from './data/config.js';

import {
    legalsolarTermsHolidayDic, legalHolidaysDic, legalLunarHolidaysDic,
    otherHolidaysList, otherLunarHolidaysList
} from './data/holidays.js';

import { getTheYearAllSolarTermsList } from './utils/solar24.js';
import { rfAdd, rfRemove, sortCollation } from './utils/tools.js';

export class Lunar {
    constructor(date = new Date(), godType = '8char', year8Char = 'year', yeargod='duty') {
        this.godType = godType;
        this.year8CharOption = year8Char;
        this.isYeargodDuty = yeargod === 'duty' ? true : false;
        this.date = date;
        this.twohourNum = Math.floor((this.date.getHours() + 1) / 2);
        this.isLunarLeapMonth = false;

        const lD = this.get_lunarDateNum();
        this.lunarYear = lD.year;
        this.lunarMonth = lD.month;
        this.lunarDay = lD.day;

        const lC = this.get_lunarCn();
        this.lunarYearCn = lC.yearCn;
        this.lunarMonthCn = lC.monthCn;
        this.lunarDayCn = lC.dayCn;

        this.phaseOfMoon = this.getPhaseOfMoon();
        this.todaySolarTerms = this.get_todaySolarTerms();
        this._x = this.getBeginningOfSpringX();

        const e8 = this.get_the8char();
        this.year8Char = e8.year;
        this.month8Char = e8.month;
        this.day8Char = e8.day;

        this.initBaseMetadata();
        this.twohour8CharList = this.get_twohour8CharList();
        this.twohour8Char = this.get_twohour8Char();
        this.get_today12DayOfficer();

        this.chineseYearZodiac = this.get_chineseYearZodiac();
        this.chineseZodiacClash = this.get_chineseZodiacClash();
        this.weekDayCn = this.get_weekDayCn();
        this.starZodiac = this.get_starZodiac();
        this.todayEastZodiac = this.get_eastZodiac();
        this.thisYearSolarTermsDic = this.generateSolarTermsDic();
        this.today28Star = this.get_the28Stars();
        this.angelDemon = this.get_AngelDemon();
        this.meridians = meridiansName[this.twohourNum % 12];
    }

    mod(n, m) {
        return ((n % m) + m) % m;
    }

    getBeginningOfSpringX() {
        if (this.year8CharOption !== 'beginningOfSpring') return 0;
        const isBeforeLunarYear = this.spanDays < 0;
        const isBeforeBeginningOfSpring = this.nextSolarNum < 3;
        if (isBeforeLunarYear) {
            return (!isBeforeBeginningOfSpring) ? -1 : 0;
        } else {
            return (isBeforeBeginningOfSpring) ? 1 : 0;
        }
    }

    get_lunarCn() {
        const yearStr = this.lunarYear.toString();
        let yCn = '';
        for (let i = 0; i < yearStr.length; i++) {
            yCn += upperNum[parseInt(yearStr[i])];
        }

        let mN = lunarMonthNameList[this.mod(this.lunarMonth - 1, 12)];
        if (this.isLunarLeapMonth) mN = "闰" + mN;

        let thisLunarMonthDays = this.monthDaysList[0];
        if (this.isLunarLeapMonth) {
            thisLunarMonthDays = this.monthDaysList[2];
        }
        this.lunarMonthLong = thisLunarMonthDays >= 30;

        const size = this.lunarMonthLong ? '大' : '小';

        return {
            yearCn: yCn,
            monthCn: mN + size,
            dayCn: lunarDayNameList[this.mod(this.lunarDay - 1, 30)]
        };
    }

    getPhaseOfMoon() {
        const long = this.lunarMonthLong ? 1 : 0;
        if (this.lunarDay - long === 15) return '望';
        if (this.lunarDay === 1) return '朔';
        if (this.lunarDay >= 7 && this.lunarDay <= 8) return '上弦';
        if (this.lunarDay >= 22 && this.lunarDay <= 23) return '下弦';
        return '';
    }

    get_chineseYearZodiac() {
        return chineseZodiacNameList[this.mod(this.lunarYear - 4 - this._x, 12)];
    }

    get_chineseZodiacClash() {
        const zN = this.dayEarthNum;
        this.zodiacMark6 = chineseZodiacNameList[this.mod(25 - zN, 12)];
        this.zodiacMark3List = [
            chineseZodiacNameList[this.mod(zN + 4, 12)],
            chineseZodiacNameList[this.mod(zN + 8, 12)]
        ];
        this.zodiacWin = chineseZodiacNameList[zN];
        this.zodiacLose = chineseZodiacNameList[this.mod(zN + 6, 12)];
        return this.zodiacWin + '日冲' + this.zodiacLose;
    }

    get_weekDayCn() {
        const d = this.date.getDay();
        const idx = d === 0 ? 6 : d - 1;
        return weekDay[idx];
    }

    getMonthLeapMonthLeapDays(y, m) {
        // 模拟 Python 的负索引环绕行为 (y-START_YEAR 可能为 -1)
        const index = this.mod(y - START_YEAR, lunarMonthData.length);
        const tmp = lunarMonthData[index];

        const month_day = (tmp & (1 << (m - 1))) ? 30 : 29;
        const leapMonth = (tmp >> 13) & 0xf;
        const leap_day = (leapMonth > 0 && (tmp & (1 << 12))) ? 30 : 29;
        this.monthDaysList = [month_day, leapMonth, leap_day];
        return { month_day, leapMonth, leap_day };
    }

    get_lunarDateNum() {
        let lYear = this.date.getFullYear();
        let lMonth = 1;
        let lDay = 1;


        const codeIndex = this.mod(lYear - START_YEAR, lunarNewYearList.length);
        const code = lunarNewYearList[codeIndex];
        const springMonth = ((code >> 5) & 0x3);
        const springDay = (code & 0x1f);

        const sD = Date.UTC(lYear, springMonth - 1, springDay);
        const curr = Date.UTC(this.date.getFullYear(), this.date.getMonth(), this.date.getDate());
        let span = Math.floor((curr - sD) / 86400000);
        this.spanDays = span;

        if (span >= 0) {
            let info = this.getMonthLeapMonthLeapDays(lYear, lMonth);
            while (span >= info.month_day) {
                span -= info.month_day;
                if (lMonth === info.leapMonth) {
                    if (span < info.leap_day) {
                        this.isLunarLeapMonth = true;
                        break;
                    }
                    span -= info.leap_day;
                }
                lMonth++;
                info = this.getMonthLeapMonthLeapDays(lYear, lMonth);
            }
            lDay += span;
        } else {
            lYear--;
            lMonth = 12;
            let info = this.getMonthLeapMonthLeapDays(lYear, lMonth);
            while (Math.abs(span) > info.month_day) {
                span += info.month_day;
                lMonth--;
                if (lMonth === info.leapMonth) {
                    if (Math.abs(span) <= info.leap_day) {
                        this.isLunarLeapMonth = true;
                        info.month_day = info.leap_day; 
                        break;
                    }
                    span += info.leap_day;
                }
                info = this.getMonthLeapMonthLeapDays(lYear, lMonth);
            }
            lDay += (info.month_day + span);
        }
        return { year: lYear, month: lMonth, day: lDay };
    }

    get_todaySolarTerms() {
        let year = this.date.getFullYear();
        let list = getTheYearAllSolarTermsList(year).map((d, i) => [Math.floor(i / 2) + 1, d]);
        this.thisYearSolarTermsDateList = list;

        const findDate = [this.date.getMonth() + 1, this.date.getDate()];

        let count = 0;
        for (let i = 0; i < list.length; i++) {
            const [m, d] = list[i];
            if (m < findDate[0] || (m === findDate[0] && d <= findDate[1])) {
                count++;
            } else {
                break;
            }
        }
        this.nextSolarNum = count % 24;

        let todayTerm = '无';
        const idx = list.findIndex(d => d[0] === findDate[0] && d[1] === findDate[1]);
        if (idx !== -1) todayTerm = SOLAR_TERMS_NAME_LIST[idx];

        if (findDate[0] === list[23][0] && findDate[1] >= list[23][1]) {
            year++;
            list = getTheYearAllSolarTermsList(year).map((d, i) => [Math.floor(i / 2) + 1, d]);
        }

        this.nextSolarTerm = SOLAR_TERMS_NAME_LIST[this.nextSolarNum];
        this.nextSolarTermDate = list[this.nextSolarNum];
        this.nextSolarTermYear = year;
        return todayTerm;
    }

    get_eastZodiac() {
        return EAST_ZODIAC_LIST[Math.floor(this.mod(SOLAR_TERMS_NAME_LIST.indexOf(this.nextSolarTerm) - 1, 24) / 2)];
    }

    get_day8Char() {
        const baseDate = Date.UTC(2019, 0, 29);
        const today = Date.UTC(this.date.getFullYear(), this.date.getMonth(), this.date.getDate());

        let dD = Math.floor((today - baseDate) / 86400000);
        let bN = the60HeavenlyEarth.indexOf('丙寅');

        // 仅依赖 twohourNum 即可，12 代表 23:00-01:00
        if (this.twohourNum === 12) {
            bN += 1;
        }

        this.dayHeavenlyEarthNum = this.mod(dD + bN, 60);
        return the60HeavenlyEarth[this.dayHeavenlyEarthNum];
    }

    get_the8char() {
        const y8 = the60HeavenlyEarth[this.mod(this.lunarYear - 4 - this._x, 60)];

        let nS = this.nextSolarNum;
        if (nS === 0 && this.date.getMonth() === 11) {
            nS = 24;
        }
        const apartNum = Math.floor((nS + 1) / 2);
        const m8 = the60HeavenlyEarth[this.mod((this.date.getFullYear() - 2019) * 12 + apartNum, 60)];

        const d8 = this.get_day8Char();

        return { year: y8, month: m8, day: d8 };
    }

    initBaseMetadata() {
        this.yearEarthNum = the12EarthlyBranches.indexOf(this.year8Char[1]);
        this.monthEarthNum = the12EarthlyBranches.indexOf(this.month8Char[1]);
        this.dayEarthNum = the12EarthlyBranches.indexOf(this.day8Char[1]);
        this.yearHeavenNum = the10HeavenlyStems.indexOf(this.year8Char[0]);
        this.monthHeavenNum = the10HeavenlyStems.indexOf(this.month8Char[0]);
        this.dayHeavenNum = the10HeavenlyStems.indexOf(this.day8Char[0]);

        this.lunarMonthNum = this.monthEarthNum % 3;
        this.lunarSeasonNum = Math.floor(this.mod(this.monthEarthNum - 2, 12) / 3);
        this.lunarMonthType = '仲季孟'[this.lunarMonthNum];
        this.lunarSeason= '春夏秋冬'[this.lunarSeasonNum];
        this.lunarSeasonName = this.lunarMonthType + this.lunarSeason;
    }

    get_twohour8CharList() {
        const begin = (the60HeavenlyEarth.indexOf(this.day8Char) * 12) % 60;
        const extended = [...the60HeavenlyEarth, ...the60HeavenlyEarth];
        return extended.slice(begin, begin + 13);
    }

    get_twohour8Char() {
        // 必须对 12 取模，以对齐 Python 的逻辑
        return this.twohour8CharList[this.twohourNum % 12];
    }

    get_starZodiac() {
        const m = this.date.getMonth() + 1;
        const d = this.date.getDate();
        const idx = STAR_ZODIAC_DATE.filter(([sm, sd]) => (sm < m || (sm === m && sd <= d))).length % 12;
        return STAR_ZODIAC_NAME[idx];
    }

    generateSolarTermsDic() {
        const d = {};
        SOLAR_TERMS_NAME_LIST.forEach((n, i) => {
            d[n] = this.thisYearSolarTermsDateList[i];
        });
        return d;
    }

    get_legalHolidays() {
        const r = [];
        if (legalsolarTermsHolidayDic[this.todaySolarTerms]) r.push(legalsolarTermsHolidayDic[this.todaySolarTerms]);
        const dk = `${this.date.getMonth() + 1}-${this.date.getDate()}`;
        if (legalHolidaysDic[dk]) r.push(legalHolidaysDic[dk]);
        if (this.lunarMonth <= 12) {
            const ldk = `${this.lunarMonth}-${this.lunarDay}`;
            if (legalLunarHolidaysDic[ldk]) r.push(legalLunarHolidaysDic[ldk]);
        }
        return r.join(',').replace(/ /g, ',');
    }

    get_otherHolidays() {
        let tempList = [], y = this.date.getFullYear(), m = this.date.getMonth() + 1, d = this.date.getDate();

        // 母亲节：5月第2个周日，父亲节：6月第3个周日
        const eastHolidays = { 5: [2, 0, '母亲节'], 6: [3, 0, '父亲节'] }; // 0 代表周日

        if (eastHolidays[m]) {
            const [targetWeek, targetDay, name] = eastHolidays[m];
            // 找到该月第一个 targetDay
            let firstDay = new Date(y, m - 1, 1);
            let firstWeekday = firstDay.getDay(); // 0 是周日
            let firstTargetDate = 1 + (targetDay - firstWeekday + 7) % 7;
            let targetDate = firstTargetDate + (targetWeek - 1) * 7;

            if (d === targetDate) {
                tempList.push(name);
            }
        }

        // 原有节日字典
        const holidayDic = otherHolidaysList[m - 1];
        if (holidayDic && holidayDic[d]) {
            tempList.push(holidayDic[d]);
        }
        return tempList.join(',');
    }

    get_otherLunarHolidays() {
        return (this.lunarMonth <= 12 && otherLunarHolidaysList[this.lunarMonth - 1][this.lunarDay]) ?
            otherLunarHolidaysList[this.lunarMonth - 1][this.lunarDay] : '';
    }

    get_pengTaboo(long = 9, delimit = ',') {
        return pengTatooList[this.dayHeavenNum].slice(0, long) + delimit + pengTatooList[this.dayEarthNum + 10].slice(0, long);
    }

    get_today12DayOfficer() {
        let men;
        if (this.godType === 'cnlunar') {
            men = this.mod(this.lunarMonth - 1 + 2, 12);
        } else {
            men = this.monthEarthNum;
        }

        this.today12DayOfficer = chinese12DayOfficers[this.mod(this.dayEarthNum - men, 12)];
        const godOffset = [8, 10, 0, 2, 4, 6, 8, 10, 0, 2, 4, 6][men];
        const eIdx = this.mod(this.dayEarthNum - godOffset, 12);
        this.today12DayGod = chinese12DayGods[eIdx];
        this.dayName = [0, 1, 4, 5, 7, 10].includes(eIdx) ? '黄道日' : '黑道日';
        return [this.today12DayOfficer, this.today12DayGod, this.dayName];
    }

    get_the28Stars() {
        const base = new Date(2019, 0, 17);
        const diff = Math.floor((this.date.getTime() - base.getTime()) / 86400000);
        return the28StarsList[this.mod(diff, 28)];
    }

    get_nayin() {
        return theHalf60HeavenlyEarth5ElementsList[Math.floor(the60HeavenlyEarth.indexOf(this.day8Char) / 2)];
    }

    get_today5Elements() {
        const n = this.get_nayin();
        return [
            '天干', this.day8Char[0], '属' + the10HeavenlyStems5ElementsList[this.dayHeavenNum],
            '地支', this.day8Char[1], '属' + the12EarthlyBranches5ElementsList[this.dayEarthNum],
            '纳音', n[n.length - 1], '属' + n[n.length - 1],
            '廿八宿', this.today28Star[0], '宿',
            '十二神', this.today12DayOfficer, '日'
        ];
    }

    get_the9FlyStar() {
        const base = new Date(2019, 0, 17);
        const d = Math.floor((this.date.getTime() - base.getTime()) / 86400000);
        const st = [7, 3, 5, 6, 8, 1, 2, 4, 9];
        return st.map(s => this.mod(s - 1 - d, 9) + 1).join('');
    }

    get_luckyGodsDirection() {
        const n = this.dayHeavenNum;
        const f = (s) => directionList[chinese8Trigrams.indexOf(s[n])];
        return [
            '喜神' + f(luckyGodDirection),
            '财神' + f(wealthGodDirection),
            '福神' + f(mascotGodDirection),
            '阳贵' + f(sunNobleDirection),
            '阴贵' + f(moonNobleDirection)
        ];
    }

    get_fetalGod() {
        return fetalGodList[the60HeavenlyEarth.indexOf(this.day8Char)];
    }

    get_twohourLuckyList() {
        const f = (t) => {
            const res = [];
            for (let i = 0; i < 12; i++) {
                res.push((t & (1 << (11 - i))) ? '凶' : '吉');
            }
            return res;
        };
        const todayList = f(twohourLuckyTimeList[this.dayHeavenlyEarthNum]);
        const tomorrowList = f(twohourLuckyTimeList[(this.dayHeavenlyEarthNum + 1) % 60]);
        return [...todayList, ...tomorrowList].slice(0, 13);
    }

    getTodayThingLevel(goodGodName, badGodName, officer) {
        const badGodDic = {
            '平日': [['亥', ['相日', '时德', '六合'], 0], ['巳', ['相日', '六合', '月刑'], 1], ['申', ['相日', '月害'], 2], ['寅', ['相日', '月害', '月刑'], 3], ['卯午酉', ['天吏'], 3], ['辰戌丑未', ['月煞'], 4], ['子', ['天吏', '月刑'], 4]],
            '收日': [['寅申', ['长生', '六合', '劫煞'], 0], ['巳亥', ['长生', '劫煞'], 2], ['辰未', ['月害'], 2], ['子午酉', ['大时'], 3], ['丑戌', ['月刑'], 3], ['卯', ['大时'], 4]],
            '闭日': [['子午卯酉', ['王日'], 3], ['辰戌丑未', ['官日', '天吏'], 3], ['寅申巳亥', ['月煞'], 4]],
            '劫煞': [['寅申', ['长生', '六合'], 0], ['辰戌丑未', ['除日', '相日'], 1], ['巳亥', ['长生', '月害'], 2], ['子午卯酉', ['执日'], 3]],
            '灾煞': [['寅申巳亥', ['开日'], 1], ['辰戌丑未', ['满日', '民日'], 2], ['子午', ['月破'], 4], ['卯酉', ['月破', '月厌'], 5]],
            '月煞': [['卯酉', ['六合', '危日'], 1], ['子午', ['月害', '危日'], 3]],
            '月刑': [['巳', ['平日', '六合', '相日'], 1], ['寅', ['相日', '月害', '平日'], 3], ['辰酉亥', ['建日'], 3], ['子', ['平日', '天吏'], 4], ['卯', ['收日', '大时', '天破'], 4], ['未申', ['月破'], 4], ['午', ['月建', '月厌', '德大会'], 4]],
            '月害': [['卯酉', ['守日', '除日'], 2], ['丑未', ['执日', '大时'], 2], ['巳亥', ['长生', '劫煞'], 2], ['申', ['相日', '平日'], 2], ['子午', ['月煞'], 3], ['辰戌', ['官日', '闭日', '天吏'], 3], ['寅', ['相日', '平日', '月刑'], 3]],
            // 注意：其中的 已 必须修正为 巳
            '月厌': [['寅申', ['成日'], 2], ['丑未', ['开日'], 2], ['辰戌', ['定日'], 3], ['巳亥', ['满日'], 3], ['子', ['月建', '德大会'], 4], ['午', ['月建', '月刑', '德大会'], 4], ['卯酉', ['月破', '灾煞'], 5]],
            // 注意：下面两处的 已 必须修正为 巳
            '大时': [['寅申巳亥', ['除日', '官日'], 0], ['辰戌', ['执日', '六合'], 0], ['丑未', ['执日', '月害'], 2], ['子午酉', ['收日'], 3], ['卯', ['收日', '月刑'], 4]],
            '天吏': [['寅申巳亥', ['危日'], 2], ['辰戌丑未', ['闭日'], 3], ['卯午酉', ['平日'], 3], ['子', ['平日', '月刑'], 4]]
        };

        const levelDic = {
            0: '上：吉足胜凶，从宜不从忌。',
            1: '上次：吉足抵凶，遇德从宜不从忌，不遇从宜亦从忌。',
            2: '中：吉不抵凶，遇德从宜不从忌，不遇从忌不从宜。',
            3: '中次：凶胜于吉，遇德从宜亦从忌，不遇从忌不从宜。',
            4: '下:凶又逢凶，遇德从忌不从宜，不遇诸事皆忌。',
            5: '下下：凶叠大凶，遇德亦诸事皆忌。（卯酉月，灾煞遇月破、月厌，月厌遇灾煞、月破）',
            '-1': '无'
        };

        const thingLevelDic = {
            0: '从宜不从忌',
            1: '从宜亦从忌',
            2: '从忌不从宜',
            3: '诸事皆忌'
        };

        const allGods = [...goodGodName, ...badGodName, officer + '日'];
        let l = -1;

        for (let gN of allGods) {
            if (badGodDic[gN]) {
                for (let item of badGodDic[gN]) {
                    if (item[0].includes(this.month8Char[1])) {
                        for (let g of item[1]) {
                            if (allGods.includes(g) && item[2] > l) {
                                l = item[2];
                                break;
                            }
                        }
                    }
                }
            }
        }

        const isDe = ['岁德', '岁德合', '月德', '月德合', '天德', '天德合'].some(g => goodGodName.includes(g));
        this.isDe = isDe;
        this.todayLevel = l;
        this.todayLevelName = levelDic[l] || '无';

        let tL;
        if (l === 5) tL = 3;
        else if (l === 4) tL = isDe ? 2 : 3;
        else if (l === 3) tL = isDe ? 1 : 2;
        else if (l === 2) tL = isDe ? 0 : 2;
        else if (l === 1) tL = isDe ? 0 : 1;
        else if (l === 0) tL = 0;
        else tL = 1; // 对应 Python 的 else: thingLevel = 1

        this.thingLevelName = thingLevelDic[tL];
        return tL;
    }

    // 核心方法：神煞与宜忌计算 - 完整对齐 Python 版
    get_AngelDemon() {
        let gbDic = {
            goodName: [],
            badName: [],
            goodThing: [...officerThings[this.today12DayOfficer][0]],
            badThing: [...officerThings[this.today12DayOfficer][1]]
        };

        const s = this.today28Star, o = this.today12DayOfficer, d = this.day8Char;
        const den = this.dayEarthNum, sn = this.lunarSeasonNum, yhn = this.yearHeavenNum;
        const yen = this.yearEarthNum, ldn = this.lunarDay, lmn = this.lunarMonth;

        const tomorrow = new Date(this.date);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tmd = [tomorrow.getMonth() + 1, tomorrow.getDate()];
        const tmdMonth = tomorrow.getMonth() + 1;
        const tmdDay = tomorrow.getDate();

        const t4l = [this.thisYearSolarTermsDic['春分'], this.thisYearSolarTermsDic['夏至'], this.thisYearSolarTermsDic['秋分'], this.thisYearSolarTermsDic['冬至']];
        const t4j = [this.thisYearSolarTermsDic['立春'], this.thisYearSolarTermsDic['立夏'], this.thisYearSolarTermsDic['立秋'], this.thisYearSolarTermsDic['立冬']];

        // 土王用事计算
        let filteredFour = t4j.filter(val => {
            if (!val) return false;
            return (val[0] < tmdMonth || (val[0] === tmdMonth && val[1] < tmdDay));
        });

        const twys = t4j[filteredFour.length % 4];

        const utcTarget = Date.UTC(this.nextSolarTermYear, twys[0] - 1, twys[1]); // 目标节气当天 00:00
        const utcCurrent = Date.UTC(this.date.getFullYear(), this.date.getMonth(), this.date.getDate(), this.date.getHours(), this.date.getMinutes()); // 当前时间

        const daysToFour = Math.floor((utcTarget - utcCurrent) / 86400000);

        const men = this.godType === 'cnlunar' ? this.mod(this.lunarMonth - 1 + 2, 12) : this.monthEarthNum;

        // 1. 日干支基础宜忌
        for (let key in day8CharThing) {
            if (d.includes(key)) {
                gbDic.goodThing = rfAdd(gbDic.goodThing, day8CharThing[key][0]);
                gbDic.badThing = rfAdd(gbDic.badThing, day8CharThing[key][1]);
            }
        }

        // 2. 特殊节气规则
        /* 
           插入卷十一拆解后遗留内容
           节气间差类
           [("小寒", 0), ("大寒", 1), ("立春", 2), ("雨水", 3), ("惊蛰", 4), ("春分", 5), ("清明", 6), ("谷雨", 7), ("立夏", 8), ("小满", 9), ("芒种", 10), ("夏至", 11), ("小暑", 12), ("大暑", 13), ("立秋", 14), ("处暑", 15), ("白露", 16), ("秋分", 17), ("寒露", 18), ("霜降", 19), ("立冬", 20), ("小雪", 21), ("大雪", 22), ("冬至", 23)]
        */

        //# 雨水后立夏前执日、危日、收日 宜 取鱼 
        if (this.nextSolarNum >= 4 && this.nextSolarNum <= 8 && ['执', '危', '收'].includes(o)) gbDic.goodThing = rfAdd(gbDic.goodThing, ['取鱼']);
        //# 霜降后立春前执日、危日、收日 宜 畋猎
        if ((this.nextSolarNum >= 20 || this.nextSolarNum <= 2) && ['执', '危', '收'].includes(o)) gbDic.goodThing = rfAdd(gbDic.goodThing, ['畋猎']);
        //# 立冬后立春前危日 午日 申日 宜 伐木
        if ((this.nextSolarNum >= 21 || this.nextSolarNum <= 2) && (o === '危' || ['午', '申'].includes(d))) {
            gbDic.goodThing = rfAdd(gbDic.goodThing, ['伐木']);
        }
        //#   每月一日 六日 十五 十九日 二十一日 二十三日 忌 整手足甲
        if ([1, 6, 15, 19, 21, 23].includes(ldn)) gbDic.badThing = rfAdd(gbDic.badThing, ['整手足甲']);
        //# 每月十二日 十五日 忌 整容剃头
        if ([12, 15].includes(ldn)) gbDic.badThing = rfAdd(gbDic.badThing, ['整容', '剃头']);
        //# 每月十五日 朔弦望月 忌 求医疗病
        if (ldn === 15 || this.phaseOfMoon !== '') gbDic.badThing = rfAdd(gbDic.badThing, ['求医疗病']);

        // 3. 神煞列表 [名称, 匹配源, 匹配目标范围, 宜, 忌]
        // 逻辑：如果 匹配源 在 匹配目标范围 中，则命中。
        const angel = [
            ['岁德', '甲庚丙壬戊甲庚丙壬戊'[yhn], d, ['修造'], []],
            ['岁德合', '己乙辛丁癸己乙辛丁癸'[yhn], d, ['修造'], []],
            ['月德', '壬庚丙甲壬庚丙甲壬庚丙甲'[men], d[0], ['祭祀', '祈福', '求嗣', '上册', '上表章', '颁诏', '覃恩', '施恩', '招贤', '举正直', '恤孤茕', '宣政事', '雪冤', '庆赐', '宴会', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '搬移', '解除', '求医疗病', '裁制', '营建', '缮城郭', '修造', '竖柱上梁', '修仓库', '栽种', '牧养', '纳畜', '安葬'], ['畋猎', '取鱼']],
            ['月德合', '丁乙辛己丁乙辛己丁乙辛己'[men], d[0], ['祭祀', '祈福', '求嗣', '上册', '上表章', '颁诏', '覃恩', '施恩', '招贤', '举正直', '恤孤茕', '宣政事', '雪冤', '庆赐', '宴会', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '搬移', '解除', '求医疗病', '裁制', '营建', '缮城郭', '修造', '竖柱上梁', '修仓库', '栽种', '牧养', '纳畜', '安葬'], ['畋猎', '取鱼']],
            // 正丁三壬四辛同，五亥六甲七癸逢；八寅九丙十居乙，子巳丑庚卯申中；戊巳绝无天德位，四仲四维不用墓。
            // 坤宫（申未）、乾宫（亥戌）、艮宫（寅丑）、巽宫（巳辰）
            // 巳	庚	丁	申	壬	辛	亥	甲	癸	寅	丙	乙
            // the10HeavenlyStems = ('甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸')
            // the12EarthlyBranches = ('子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥')
            // 地地 天 天 地地 天 天 地地 天 天 地地 天 天
            // 2026-01-26 01:30:00  季  乙巳 己丑 庚子 丁丑
            //['天德', '巳庚丁申壬辛亥甲癸寅丙乙'[men], d, ['祭祀', '祈福', '求嗣', '上册', '上表章', '颁诏', '覃恩', '施恩', '招贤', '举正直', '恤孤茕', '宣政事', '雪冤', '庆赐', '宴会', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '搬移', '解除', '求医疗病', '裁制', '营建', '缮城郭', '修造', '竖柱上梁', '修仓库', '栽种', '牧养', '纳畜', '安葬'], ['畋猎', '取鱼']],
            ['天德', this.lunarMonthType == '仲' ? d[1] : d[0], ['巳辰','庚','丁','申未','壬','辛','亥戌','甲','癸','寅丑','丙','乙'][men], ['祭祀', '祈福', '求嗣', '上册', '上表章', '颁诏', '覃恩', '施恩', '招贤', '举正直', '恤孤茕', '宣政事', '雪冤', '庆赐', '宴会', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '搬移', '解除', '求医疗病', '裁制', '营建', '缮城郭', '修造', '竖柱上梁', '修仓库', '栽种', '牧养', '纳畜', '安葬'], ['畋猎', '取鱼']],
            ['天德合', '空乙壬空丁丙空己戊空辛庚'[men], d, ['祭祀', '祈福', '求嗣', '上册', '上表章', '颁诏', '覃恩', '施恩', '招贤', '举正直', '恤孤茕', '宣政事', '雪冤', '庆赐', '宴会', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '搬移', '解除', '求医疗病', '裁制', '营建', '缮城郭', '修造', '竖柱上梁', '修仓库', '栽种', '牧养', '纳畜', '安葬'], ['畋猎', '取鱼']],
            ['凤凰日', s[0], ['危', '昴', '胃', '毕'][sn], ['嫁娶'], []],
            ['麒麟日', s[0], ['井', '尾', '牛', '壁'][sn], ['嫁娶'], []],
            ['三合', (den - men) % 4 === 0, true, ['庆赐', '宴会', '结婚姻', '纳采', '嫁娶', '进人口', '裁制', '修宫室', '缮城郭', '修造', '竖柱上梁', '修仓库', '经络', '酝酿', '立券交易', '纳财', '安碓硙', '纳畜'], []],
            ['四相', d[0], ['丙丁', '戊己', '壬癸', '甲乙'][sn], ['祭祀', '祈福', '求嗣', '施恩', '举正直', '庆赐', '宴会', '出行', '上官', '临政', '结婚姻', '纳采', '搬移', '解除', '求医疗病', '裁制', '修宫室', '缮城郭', '修造', '竖柱上梁', '纳财', '开仓', '栽种', '牧养'], []],
            ['五合', d[1], '寅卯', ['宴会', '结婚姻', '立券交易'], []],
            ['五富', '巳申亥寅巳申亥寅巳申亥寅'[men], d, ['经络', '酝酿', '开市', '立券交易', '纳财', '开仓', '栽种', '牧养', '纳畜'], []],
            ['六合', '丑子亥戌酉申未午巳辰卯寅'[men], d, ['宴会', '结婚姻', '嫁娶', '进人口', '经络', '酝酿', '立券交易', '纳财', '纳畜', '安葬'], []],
            ['六仪', '午巳辰卯寅丑子亥戌酉申未'[men], d, ['临政'], []],
            ['不将', d, bujiang[men], ['嫁娶'], []],
            ['时德', ['午', '辰', '子', '寅'][sn], d[1], ['祭祀', '祈福', '求嗣', '施恩', '举正直', '庆赐', '宴会', '出行', '上官', '临政', '结婚姻', '纳采', '搬移', '解除', '求医疗病', '裁制', '修宫室', '缮城郭', '修造', '竖柱上梁', '纳财', '开仓', '栽种', '牧养'], []],
            ['大葬', d, '壬申癸酉壬午甲申乙酉丙申丁酉壬寅丙午己酉庚申辛酉', ['安葬'], []],
            ['鸣吠', d, '庚午壬申癸酉壬午甲申乙酉己酉丙申丁酉壬寅丙午庚寅庚申辛酉', ['破土', '安葬'], []],
            ['小葬', d, '庚午壬辰甲辰乙巳甲寅丙辰庚寅', ['安葬'], []],
            ['鸣吠对', d, '丙寅丁卯丙子辛卯甲午庚子癸卯壬子甲寅乙卯', ['破土', '启攒'], []],
            ['不守塚', d, '庚午辛未壬申癸酉戊寅己卯壬午癸未甲申乙酉丁未甲午乙未丙申丁酉壬寅癸卯丙午戊申己酉庚申辛酉', ['破土'], []],
            ['王日', ['寅', '巳', '申', '亥'][sn], d[1], ['颁诏', '覃恩', '施恩', '招贤', '举正直', '恤孤茕', '宣政事', '雪冤', '庆赐', '宴会', '出行', '安抚边境', '选将', '上官', '临政', '裁制'], []],
            ['官日', ['卯', '午', '酉', '子'][sn], d[1], ['上官', '临政'], []],
            ['守日', ['酉', '子', '卯', '午'][sn], d[1], ['安抚边境', '上官', '临政'], []],
            ['相日', ['巳', '申', '亥', '寅'][sn], d[1], ['上官', '临政'], []],
            ['民日', ['午', '酉', '子', '卯'][sn], d[1], ['宴会', '结婚姻', '纳采', '进人口', '搬移', '开市', '立券交易', '纳财', '栽种', '牧养', '纳畜'], []],
            ['临日', '辰酉午亥申丑戌卯子巳寅未'[men], d, ['上册', '上表章', '上官', '临政'], []],
            ['天贵', d[0], ['甲乙', '丙丁', '庚辛', '壬癸'][sn], [], []],
            ['天喜', '申酉戌亥子丑寅卯辰巳午未'[men], d[1], ['施恩', '举正直', '庆赐', '宴会', '出行', '上官', '临政', '结婚姻', '纳采', '嫁娶'], []],
            ['天富', '寅卯辰巳午未申酉戌亥子丑'[men], d, ['安葬', '修仓库'], []],
            ['天恩', (this.dayHeavenlyEarthNum % 15 < 5 && Math.floor(this.dayHeavenlyEarthNum / 15) !== 2), true, ['覃恩', '恤孤茕', '布政事', '雪冤', '庆赐', '宴会'], []],
            ['月恩', '甲辛丙丁庚己戊辛壬癸庚乙'[men], d, ['祭祀', '祈福', '求嗣', '施恩', '举正直', '庆赐', '宴会', '出行', '上官', '临政', '结婚姻', '纳采', '搬移', '解除', '求医疗病', '裁制', '修宫室', '缮城郭', '修造', '竖柱上梁', '纳财', '开仓', '栽种', '牧养'], []],
            ['天赦', ['甲子', '甲子', '戊寅', '戊寅', '戊寅', '甲午', '甲午', '甲午', '戊申', '戊申', '戊申', '甲子'][men], d, ['祭祀', '祈福', '求嗣', '上册', '上表章', '颁诏', '覃恩', '施恩', '招贤', '举正直', '恤孤茕', '宣政事', '雪冤', '庆赐', '宴会', '出行', '安抚边境', '选将', '上官', '临政', '结婚姻', '纳采', '嫁娶', '搬移', '解除', '求医疗病', '裁制', '营建', '缮城郭', '修造', '竖柱上梁', '修仓库', '栽种', '牧养', '纳畜', '安葬'], ['畋猎', '取鱼']],
            ['天愿', ['甲子', '癸未', '甲午', '甲戌', '乙酉', '丙子', '丁丑', '戊午', '甲寅', '丙辰', '辛卯', '戊辰'][men], d, ['祭祀', '祈福', '求嗣', '上册', '上表章', '颁诏', '覃恩', '施恩', '招贤', '举正直', '恤孤茕', '宣政事', '雪冤', '庆赐', '宴会', '出行', '安抚边境', '选将', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '裁制', '营建', '缮城郭', '修造', '竖柱上梁', '修仓库', '经络', '酝酿', '开市', '立券交易', '纳财', '栽种', '牧养', '纳畜', '安葬'], []],
            ['天成', '卯巳未酉亥丑卯巳未酉亥丑'[men], d, [], []],
            ['天官', '午申戌子寅辰午申戌子寅辰'[men], d, [], []],
            ['天医', '亥子丑寅卯辰巳午未申酉戌'[men], d, ['求医疗病'], []],
            ['天马', '寅辰午申戌子寅辰午申戌子'[men], d, ['出行', '搬移'], []],
            ['驿马', '寅亥申巳寅亥申巳寅亥申巳'[men], d, ['出行', '搬移'], []],
            ['天财', '子寅辰午申戌子寅辰午申戌'[men], d, [], []],
            ['福生', '寅申酉卯戌辰亥巳子午丑未'[men], d, ['祭祀', '祈福'], []],
            ['福厚', ['寅', '巳', '申', '亥'][sn], d, [], []],
            ['福德', '寅卯辰巳午未申酉戌亥子丑'[men], d, ['上册', '上表章', '庆赐', '宴会', '修宫室', '缮城郭'], []],
            ['天巫', '寅卯辰巳午未申酉戌亥子丑'[men], d, ['求医疗病'], []],
            ['地财', '丑卯巳未酉亥丑卯巳未酉亥'[men], d, [], []],
            ['月财', '酉亥午巳巳未酉亥午巳巳未'[men], d, [], []],
            ['月空', '丙甲壬庚丙甲壬庚丙甲壬庚'[men], d, ['上表章'], []],
            ['母仓', d[1], ['亥子', '寅卯', '辰丑戌未', '申酉'][sn], ['纳财', '栽种', '牧养', '纳畜'], []],
            ['明星', '辰午甲戌子寅辰午甲戌子寅'[men], d, ['赴任', '诉讼', '安葬'], []],
            ['圣心', '辰戌亥巳子午丑未寅申卯酉'[men], d, ['祭祀', '祈福'], []],
            ['禄库', '寅卯辰巳午未申酉戌亥子丑'[men], d, ['纳财'], []],
            ['吉庆', '未子酉寅亥辰丑午卯申巳戌'[men], d, [], []],
            ['阴德', '丑亥酉未巳卯丑亥酉未巳卯'[men], d, ['恤孤茕', '雪冤'], []],
            ['活曜', '卯申巳戌未子酉寅亥辰丑午'[men], d, [], []],
            ['除神', d[1], '申酉', ['解除', '沐浴', '整容', '剃头', '整手足甲', '求医疗病', '扫舍宇'], []],
            ['解神', '午午申申戌戌子子寅寅辰辰'[men], d, ['上表章', '解除', '沐浴', '整容', '剃头', '整手足甲', '求医疗病'], []],
            ['生气', '戌亥子丑寅卯辰巳午未申酉'[men], d, [], ['伐木', '畋猎', '取鱼']],
            ['普护', '丑卯申寅酉卯戌辰亥巳子午'[men], d, ['祭祀', '祈福'], []],
            ['益后', '巳亥子午丑未寅申卯酉辰戌'[men], d, ['祭祀', '祈福', '求嗣'], []],
            ['续世', '午子丑未寅申卯酉辰戌巳亥'[men], d, ['祭祀', '祈福', '求嗣'], []],
            ['要安', '未丑寅申卯酉辰戌巳亥午子'[men], d, [], []],
            ['天后', '寅亥申巳寅亥申巳寅亥申巳'[men], d, ['求医疗病'], []],
            ['天仓', '辰卯寅丑子亥戌酉申未午巳'[men], d, ['进人口', '纳财', '纳畜'], []],
            ['敬安', '子午未丑申寅酉卯戌辰亥巳'[men], d, [], []],
            ['玉宇', '申寅卯酉辰戌巳亥午子未丑'[men], d, [], []],
            ['金堂', '酉卯辰戌巳亥午子未丑申寅'[men], d, [], []],
            ['吉期', '丑寅卯辰巳午未申酉戌亥子'[men], d, ['施恩', '举正直', '出行', '上官', '临政'], []],
            ['小时', '子丑寅卯辰巳午未申酉戌亥'[men], d, [], []],
            ['兵福', '子丑寅卯辰巳午未申酉戌亥'[men], d, ['安抚边境', '选将', '出师'], []],
            ['兵宝', '丑寅卯辰巳午未申酉戌亥子'[men], d, ['安抚边境', '选将', '出师'], []],
            ['兵吉', d[1], ['寅卯辰巳', '丑寅卯辰', '子丑寅卯', '亥子丑寅', '戌亥子丑', '酉戌亥子', '申酉戌亥', '未申酉戌', '午未申酉', '巳午未申', '辰巳午未', '卯辰巳午'][men], ['安抚边境', '选将', '出师'], []],
        ];

        const demon = [
            ['岁破', den === this.mod(yen + 6, 12), true, [], ['修造', '搬移', '嫁娶', '出行']],
            ['天罡', '卯戌巳子未寅酉辰亥午丑申'[men], d, [], ['安葬']],
            ['河魁', '酉辰亥午丑申卯戌巳子未寅'[men], d, [], ['安葬']],
            ['死神', '卯辰巳午未申酉戌亥子丑寅'[men], d, [], ['安抚边境', '选将', '出师', '进人口', '解除', '求医疗病', '修置产室', '栽种', '牧养', '纳畜']],
            ['死气', '辰巳午未申酉戌亥子丑寅卯'[men], d, [], ['安抚边境', '选将', '出师', '解除', '求医疗病', '修置产室', '栽种']],
            ['官符', '辰巳午未申酉戌亥子丑寅卯'[men], d, [], ['上表章', '上册']],
            ['月建', '子丑寅卯辰巳午未申酉戌亥'[men], d, [], ['祈福', '求嗣', '上册', '上表章', '结婚姻', '纳采', '解除', '整容', '剃头', '整手足甲', '求医疗病', '营建', '修宫室', '缮城郭', '修造', '竖柱上梁', '修仓库', '开仓', '修置产室', '破屋坏垣', '伐木', '栽种', '破土', '安葬', '启攒']],
            ['月破', '午未申酉戌亥子丑寅卯辰巳'[men], d, ['破屋坏垣'], ['祈福', '求嗣', '上册', '上表章', '颁诏', '施恩', '招贤', '举正直', '宣政事', '布政事', '庆赐', '宴会', '冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '安床', '整容', '剃头', '整手足甲', '裁制', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '修仓库', '鼓铸', '经络', '酝酿', '开市', '立券交易', '纳财', '开仓', '修置产室', '开渠', '穿井', '安碓硙', '塞穴', '补垣', '修饰垣墙', '伐木', '栽种', '牧养', '纳畜', '破土', '安葬', '启攒']],
            ['月煞', '未辰丑戌未辰丑戌未辰丑戌'[men], d, [], ['祈福', '求嗣', '上册', '上表章', '颁诏', '施恩', '招贤', '举正直', '宣政事', '布政事', '庆赐', '宴会', '冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '安床', '解除', '整容', '剃头', '整手足甲', '求医疗病', '裁制', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '修仓库', '鼓铸', '经络', '酝酿', '开市', '立券交易', '纳财', '开仓', '修置产室', '开渠', '穿井', '安碓硙', '塞穴', '补垣', '修饰垣墙', '破屋坏垣', '栽种', '牧养', '纳畜', '安葬']],
            ['月害', '未午巳辰卯寅丑子亥戌酉申'[men], d, [], ['祈福', '求嗣', '上册', '上表章', '庆赐', '宴会', '安抚边境', '选将', '出师', '上官', '纳采', '嫁娶', '进人口', '求医疗病', '修仓库', '经络', '酝酿', '开市', '立券交易', '纳财', '开仓', '修置产室', '牧养', '纳畜', '破土', '安葬', '启攒']],
            ['月刑', '卯戌巳子辰申午丑寅酉未亥'[men], d, [], ['祈福', '求嗣', '上册', '上表章', '颁诏', '施恩', '招贤', '举正直', '宣政事', '布政事', '庆赐', '宴会', '冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '安床', '解除', '整容', '剃头', '整手足甲', '求医疗病', '裁制', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '修仓库', '鼓铸', '经络', '酝酿', '开市', '立券交易', '纳财', '开仓', '修置产室', '开渠', '穿井', '安碓硙', '塞穴', '补垣', '修饰垣墙', '破屋坏垣', '栽种', '牧养', '纳畜', '破土', '安葬', '启攒']],
            ['月厌', '子亥戌酉申未午巳辰卯寅丑'[men], d, [], ['祈福', '求嗣', '上册', '上表章', '颁诏', '施恩', '招贤', '举正直', '宣政事', '布政事', '庆赐', '宴会', '冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '远回', '安床', '解除', '整容', '剃头', '整手足甲', '求医疗病', '裁制', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '修仓库', '鼓铸', '经络', '酝酿', '开市', '立券交易', '纳财', '开仓', '修置产室', '开渠', '穿井', '安碓硙', '塞穴', '补垣', '修饰垣墙', '平治道涂', '破屋坏垣', '伐木', '栽种', '牧养', '纳畜', '破土', '安葬', '启攒']],
            ['月忌', ldn, [5, 14, 23], [], ['出行', '乘船渡水']],
            ['月虚', '未辰丑戌未辰丑戌未辰丑戌'[men], d, [], ['修仓库', '纳财', '开仓']],
            ['灾煞', '午卯子酉午卯子酉午卯子酉'[men], d, [], ['祈福', '求嗣', '上册', '上表章', '颁诏', '施恩', '招贤', '举正直', '宣政事', '布政事', '庆赐', '宴会', '冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '安床', '解除', '整容', '剃头', '整手足甲', '求医疗病', '裁制', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '修仓库', '鼓铸', '经络', '酝酿', '开市', '立券交易', '纳财', '开仓', '修置产室', '开渠', '穿井', '安碓硙', '塞穴', '补垣', '修饰垣墙', '破屋坏垣', '栽种', '牧养', '纳畜', '破土', '安葬', '启攒']],
            ['劫煞', '巳寅亥申巳寅亥申巳寅亥申'[men], d, [], ['祈福', '求嗣', '上册', '上表章', '颁诏', '施恩', '招贤', '举正直', '宣政事', '布政事', '庆赐', '宴会', '冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '安床', '解除', '整容', '剃头', '整手足甲', '求医疗病', '裁制', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '修仓库', '鼓铸', '经络', '酝酿', '开市', '立券交易', '纳财', '开仓', '修置产室', '开渠', '穿井', '安碓硙', '塞穴', '补垣', '修饰垣墙', '破屋坏垣', '栽种', '牧养', '纳畜', '破土', '安葬', '启攒']],
            ['厌对', '午巳辰卯寅丑子亥戌酉申未'[men], d, [], ['嫁娶']],
            ['招摇', '午巳辰卯寅丑子亥戌酉申未'[men], d, [], ['取鱼', '乘船渡水']],
            ['小红砂', '酉丑巳酉丑巳酉丑巳酉丑巳'[men], d, [], ['嫁娶']],
            ['往亡', '戌丑寅巳申亥卯午酉子辰未'[men], d, [], ['上册', '上表章', '颁诏', '招贤', '宣政事', '出行', '安抚边境', '选将', '出师', '上官', '临政', '嫁娶', '进人口', '搬移', '求医疗病', '捕捉', '畋猎', '取鱼']],
            ['重丧', '癸己甲乙己丙丁己庚辛己壬'[men], d, [], ['嫁娶', '安葬']],
            ['重复', '癸己庚辛己壬癸戊甲乙己壬'[men], d, [], ['嫁娶', '安葬']],
            ['杨公忌', [lmn, ldn], [[1, 13], [2, 11], [3, 9], [4, 7], [5, 5], [6, 2], [7, 1], [7, 29], [8, 27], [9, 25], [10, 23], [11, 21], [12, 19]], [], ['开张', '修造', '嫁娶', '立券']],
            ['神号', '申酉戌亥子丑寅卯辰巳午未'[men], d, [], []],
            ['妨择', '辰辰午午申申戌戌子子寅寅'[men], d, [], []],
            ['披麻', '午卯子酉午卯子酉午卯子酉'[men], d, [], ['嫁娶', '入宅']],
            ['大耗', '辰巳午未申酉戌亥子丑寅卯'[men], d, [], ['修仓库', '开市', '立券交易', '纳财', '开仓']],
            ['伏兵', '丙甲壬庚'[yen % 4], d[0], [], ['修仓库', '修造', '出师']],
            ['大祸', '丁乙癸辛'[yen % 4], d[0], [], ['修仓库', '修造', '出师']],
            ['天吏', '卯子酉午卯子酉午卯子酉午'[men], d, [], ['祈福', '求嗣', '上册', '上表章', '施恩', '招贤', '举正直', '冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '安床', '解除', '求医疗病', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '修仓库', '开市', '立券交易', '纳财', '开仓', '修置产室', '栽种', '牧养', '纳畜']],
            ['天瘟', '丑卯未戌辰寅午子酉申巳亥'[men], d, [], ['修造', '求医疗病', '纳畜']],
            ['天狱', '午酉子卯午酉子卯午酉子卯'[men], d, [], []],
            ['天火', '午酉子卯午酉子卯午酉子卯'[men], d, [], ['苫盖']],
            ['天棒', '寅辰午申戌子寅辰午申戌子'[men], d, [], []],
            ['天狗', '寅卯辰巳午未申酉戌亥子丑'[men], d, [], ['祭祀']],
            ['天狗下食', '戌亥子丑寅卯辰巳午未申酉'[men], d, [], ['祭祀']],
            ['天贼', '卯寅丑子亥戌酉申未午巳辰'[men], d, [], ['出行', '修仓库', '开仓']],
            ['地囊', d, ['辛未辛酉', '乙酉乙未', '庚子庚午', '癸未癸丑', '甲子甲寅', '己卯己丑', '戊辰戊午', '癸未癸巳', '丙寅丙申', '丁卯丁巳', '戊辰戊子', '庚戌庚子'][men], [], ['营建', '修宫室', '缮城郭', '筑堤防', '修造', '修仓库', '修置产室', '开渠', '穿井', '安碓硙', '补垣', '修饰垣墙', '平治道涂', '破屋坏垣', '栽种', '破土']],
            ['地火', '子亥戌酉申未午巳辰卯寅丑'[men], d, [], ['栽种']],
            ['独火', '未午巳辰卯寅丑子亥戌酉申'[men], d, [], ['修造']],
            ['受死', '卯酉戌辰亥巳子午丑未寅申'[men], d, [], ['畋猎']],
            ['黄沙', '寅子午寅子午寅子午寅子午'[men], d, [], ['出行']],
            ['六不成', '卯未寅午戌巳酉丑申子辰亥'[men], d, [], ['修造']],
            ['小耗', '卯辰巳午未申酉戌亥子丑寅'[men], d, [], ['修仓库', '开市', '立券交易', '纳财', '开仓']],
            ['神隔', '酉未巳卯丑亥酉未巳卯丑亥'[men], d, [], ['祭祀', '祈福', '安葬']],
            ['朱雀', '亥丑卯巳未酉亥丑卯巳未酉'[men], d, [], ['嫁娶']],
            ['白虎', '寅辰午申戌子寅辰午申戌子'[men], d, [], ['安葬']],
            ['玄武', '巳未酉亥丑卯巳未酉亥丑卯'[men], d, [], ['安葬']],
            ['勾陈', '未酉亥丑卯巳未酉亥丑卯巳'[men], d, [], []],
            ['木马', '辰午巳未酉申戌子亥丑卯寅'[men], d, [], []],
            ['破败', '辰午申戌子寅辰午申戌子寅'[men], d, [], []],
            ['殃败', '巳辰卯寅丑子亥戌酉申未午'[men], d, [], []],
            ['雷公', '巳申寅亥巳申寅亥巳申寅亥'[men], d, [], []],
            ['飞廉', '申酉戌巳午未寅卯辰亥子丑'[men], d, [], ['纳畜', '修造', '搬移', '嫁娶']],
            ['大煞', '申酉戌巳午未寅卯辰亥子丑'[men], d, [], ['安抚边境', '选将', '出师']],
            ['枯鱼', '申巳辰丑戌未卯子酉午寅亥'[men], d, [], ['栽种']],
            ['九空', '申巳辰丑戌未卯子酉午寅亥'[men], d, [], ['进人口', '修仓库', '开市', '立券交易', '纳财', '开仓']],
            ['八座', '酉戌亥子丑寅卯辰巳午未申'[men], d, [], []],
            ['八风触水龙', d, ['丁丑己酉', '甲申甲辰', '辛未丁未', '甲戌甲寅'][sn], [], ['取鱼', '乘船渡水']],
            ['血忌', ['午', '子', '丑', '未', '寅', '申', '卯', '酉', '辰', '戌', '巳', '亥'][men], d, [], ['针刺']],
            ['阴错', '壬子癸丑庚寅辛卯庚辰丁巳丙午丁未甲申乙酉甲戌癸亥'.substring(men * 2, men * 2 + 2), d, [], []],
            ['三娘煞', ldn, [3, 7, 13, 18, 22, 27], [], ['嫁娶', '结婚姻']],
            ['四绝', tmd, t4j, [], ['出行', '上官', '嫁娶', '进人口', '搬移', '开市', '立券交易', '祭祀']],
            ['四离', tmd, t4l, [], ['出行', '嫁娶']],
            ['四击', '未未戌戌戌丑丑丑辰辰辰未'[men], d, [], ['安抚边境', '选将', '出师']],
            ['四耗', d, ['壬子', '乙卯', '戊午', '辛酉'][sn], [], ['安抚边境', '选将', '出师', '修仓库', '开市', '立券交易', '纳财', '开仓']],
            ['四穷', d, ['乙亥', '丁亥', '辛亥', '癸亥'][sn], [], ['安抚边境', '选将', '出师', '结婚姻', '纳采', '嫁娶', '进人口', '修仓库', '开市', '立券交易', '纳财', '开仓', '安葬']],
            ['四忌', d, ['甲子', '丙子', '庚子', '壬子'][sn], [], ['安抚边境', '选将', '出师', '结婚姻', '纳采', '嫁娶', '安葬']],
            ['四废', d, ['庚申辛酉', '壬子癸亥', '甲寅乙卯', '丁巳丙午'][sn], [], ['祈福', '求嗣', '上册', '上表章', '颁诏', '施恩', '招贤', '举正直', '宣政事', '布政事', '庆赐', '宴会', '冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '安床', '解除', '求医疗病', '裁制', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '修仓库', '鼓铸', '经络', '酝酿', '开市', '立券交易', '纳财', '开仓', '修置产室', '开渠', '穿井', '安碓硙', '塞穴', '补垣', '修饰垣墙', '栽种', '牧养', '纳畜', '破土', '安葬', '启攒']],
            ['五墓', ['壬辰', '戊辰', '乙未', '乙未', '戊辰', '丙戌', '丙戌', '戊辰', '辛丑', '辛丑', '戊辰', '壬辰'][men], d, [], ['冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '安床', '解除', '求医疗病', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '开市', '立券交易', '修置产室', '栽种', '牧养', '纳畜', '破土', '安葬', '启攒']],
            ['五虚', d[1], ['巳酉丑', '申子辰', '亥卯未', '寅午戌'][sn], [], ['修仓库', '开仓']],
            ['五离', d[1], '申酉', ['沐浴'], ['庆赐', '宴会', '结婚姻', '纳采', '立券交易']],
            ['五鬼', '未戌午寅辰酉卯申丑巳子亥'[men], d, [], ['出行']],
            ['八专', d, ['丁未', '己未', '庚申', '甲寅', '癸丑'], [], ['安抚边境', '选将', '出师', '结婚姻', '纳采', '嫁娶']],
            ['九坎', '申巳辰丑戌未卯子酉午寅亥'[men], d, [], ['塞穴', '补垣', '取鱼', '乘船渡水']],
            ['九焦', '申巳辰丑戌未卯子酉午寅亥'[men], d, [], ['鼓铸', '栽种']],
            ['天转', '乙卯丙午辛酉壬子'.substring(sn * 2, sn * 2 + 2), d, [], ['修造', '搬移', '嫁娶']],
            ['地转', '辛卯戊午癸酉丙子'.substring(sn * 2, sn * 2 + 2), d, [], ['修造', '搬移', '嫁娶']],
            ['月建转杀', ['卯', '午', '酉', '子'][sn], d, [], ['修造']],
            ['荒芜', d[1], ['巳酉丑', '申子辰', '亥卯未', '寅午戌'][sn], [], []],
            ['蚩尤', '戌子寅辰午申'[men % 6], d, [], []],
            ['大时', '酉午卯子酉午卯子酉午卯子'[men], d, [], ['祈福', '求嗣', '上册', '上表章', '施恩', '招贤', '举正直', '冠带', '出行', '安抚边境', '选将', '出师', '上官', '临政', '结婚姻', '纳采', '嫁娶', '进人口', '搬移', '安床', '解除', '求医疗病', '营建', '修宫室', '缮城郭', '筑堤防', '修造', '竖柱上梁', '修仓库', '开市', '立券交易', '纳财', '开仓', '修置产室', '栽种', '牧养', '纳畜']],
            ['大败', '酉午卯子酉午卯子酉午卯子'[men], d, [], []],
            ['咸池', '酉午卯子酉午卯子酉午卯子'[men], d, [], ['嫁娶', '取鱼', '乘船渡水']],
            ['土符', '申子丑巳酉寅午戌卯未亥辰'[men], d, [], ['营建', '修宫室', '缮城郭', '筑堤防', '修造', '修仓库', '修置产室', '开渠', '穿井', '安碓硙', '补垣', '修饰垣墙', '平治道涂', '破屋坏垣', '栽种', '破土']],
            ['土府', '子丑寅卯辰巳午未申酉戌亥'[men], d, [], ['营建', '修宫室', '缮城郭', '筑堤防', '修造', '修仓库', '修置产室', '开渠', '穿井', '安碓硙', '补垣', '修饰垣墙', '平治道涂', '破屋坏垣', '栽种', '破土']],
            ['土王用事', daysToFour, Array.from({ length: 18 }, (_, k) => k), [], ['营建', '修宫室', '缮城郭', '筑堤防', '修造', '修仓库', '修置产室', '开渠', '穿井', '安碓硙', '补垣', '修饰垣墙', '平治道涂', '破屋坏垣', '栽种', '破土']],
            ['血支', '亥子丑寅卯辰巳午未申酉戌'[men], d, [], ['针刺']],
            ['游祸', '亥申巳寅亥申巳寅亥申巳寅'[men], d, [], ['祈福', '求嗣', '解除', '求医疗病']],
            ['归忌', '寅子丑寅子丑寅子丑寅子丑'[men], d, [], ['搬移', '远回']],
            ['岁薄', [lmn, d], [[4, '戊午'], [4, '丙午'], [10, '壬子'], [10, '戊子']], [], []],
            ['逐阵', [lmn, d], [[6, '戊午'], [6, '丙午'], [12, '壬子'], [12, '戊子']], [], []],
            ['阴阳交破', [lmn, d], [[10, '丁巳']], [], []],
            ['宝日', d, ['丁未', '丁丑', '丙戌', '甲午', '庚子', '壬寅', '癸卯', '乙巳', '戊申', '己酉', '辛亥', '丙辰'], [], []],
            ['义日', d, ['甲子', '丙寅', '丁卯', '己巳', '辛未', '壬申', '癸酉', '乙亥', '庚辰', '辛丑', '庚戌', '戊午'], [], []],
            ['制日', d, ['乙丑', '甲戌', '壬午', '戊子', '庚寅', '辛卯', '癸巳', '乙未', '丙申', '丁酉', '己亥', '甲辰'], [], []],
            ['伐日', d, ['庚午', '辛巳', '丙子', '戊寅', '己卯', '癸未', '癸丑', '甲申', '乙酉', '丁亥', '壬辰', '壬戌'], [], ['安抚边境', '选将', '出师']],
            ['专日', d, ['甲寅', '乙卯', '丁巳', '丙午', '庚申', '辛酉', '癸亥', '壬子', '戊辰', '戊戌', '己丑', '己未'], [], ['安抚边境', '选将', '出师']],
            ['重日', d[1], '巳亥', [], ['破土', '安葬', '启攒']],
            ['复日', '癸巳甲乙戊丙丁巳庚辛戊壬'[men], d, ['裁制'], ['破土', '安葬', '启攒']],
        ];

        const processDB = (db, listKey) => {
            db.forEach(item => {
                const [name, source, target, good, bad] = item;
                let matched = false;

                if (name === '杨公忌' || name === '岁薄' || name === '逐阵' || name === '阴阳交破') {
                    // 源和目标都是 [月, 日] 或包含 [月, 柱] 的元组对比
                    matched = target.some(val => val[0] === source[0] && val[1] === source[1]);
                } else if (name === '四绝' || name === '四离') {
                    // 对比日期对
                    matched = target.some(val => val[0] === source[0] && val[1] === source[1]);
                } else if (target === true) {
                    matched = !!source;
                } else if (Array.isArray(target)) {
                    matched = target.includes(source);
                } else if (typeof target === 'string') {
                    matched = target.includes(source);
                } else {
                    matched = source === target;
                }

                // 岁神
                if (!this.isYeargodDuty && name[0] === '岁') {
                    matched =false; 
                }

                if (matched) {
                    gbDic[listKey].push(name);
                    gbDic.goodThing = rfAdd(gbDic.goodThing, good);
                    gbDic.badThing = rfAdd(gbDic.badThing, bad);
                }
            });
        };

        processDB(angel, 'goodName');
        processDB(demon, 'badName');

        // 5. 过滤逻辑 (严格对齐 Python badDrewGood/badOppressGood 等)

        //# 第一方案：《钦定协纪辨方书》古书影印版，宜忌等第表
        //# 凡铺注《万年历》、《通书》，先依用事次第察其所宜忌之日，于某日下注宜某事，某日下注忌某事，次按宜忌，较量其凶吉之轻重，以定去取。
        const thingLevel = this.getTodayThingLevel(gbDic.goodName, gbDic.badName, o);
        if (thingLevel === 3) {
            //# 诸事不宜
            gbDic.goodThing = ['诸事不宜'];
            gbDic.badThing = ['诸事不宜'];
        } else if (thingLevel === 2) {
            //# 从忌不从宜
            const inter = gbDic.goodThing.filter(x => gbDic.badThing.includes(x));
            gbDic.goodThing = rfRemove(gbDic.goodThing, inter);
        } else if (thingLevel === 1) {
            //# 从忌亦从宜
            const inter = gbDic.goodThing.filter(x => gbDic.badThing.includes(x));
            gbDic.goodThing = rfRemove(gbDic.goodThing, inter);
            gbDic.badThing = rfRemove(gbDic.badThing, inter);
        } else {
            //# 从宜不从忌
            const inter = gbDic.badThing.filter(x => gbDic.goodThing.includes(x));
            gbDic.badThing = rfRemove(gbDic.badThing, inter);
        }

        this.goodThing = gbDic.goodThing;
        this.badThing = gbDic.badThing;

        // 6. 遇德犹忌特殊规则
        const deIsBadThingDic = {};
        angel.slice(0, 6).forEach(i => deIsBadThingDic[i[0]] = i[4]);
        let deIsBadThing = [];
        if (this.isDe) {
            gbDic.goodName.forEach(name => {
                if (deIsBadThingDic[name]) deIsBadThing = rfAdd(deIsBadThing, deIsBadThingDic[name]);
            });
        }

        if (thingLevel !== 3) {
            //# 凡宜宣政事，布政事之日，只注宜宣政事。
            if (this.goodThing.includes('宣政事') && this.goodThing.includes('布政事')) this.goodThing = rfRemove(this.goodThing, ['布政事']);
            //# 凡宜营建宫室、修宫室之日，只注宜营建宫室。
            if (this.goodThing.includes('营建宫室') && this.goodThing.includes('修宫室')) this.goodThing = rfRemove(this.goodThing, ['修宫室']);
            //# 凡德合、赦愿、月恩、四相、时德等日，不注忌进人口、安床、经络、酝酿、开市、立券、交易、纳财、开仓库、出货财。如遇德犹忌，及从忌不从宜之日，则仍注忌。
            let _maxPowerGodList = ['月德合', '天德合', '天赦', '天愿', '月恩', '四相', '时德'];
            if (this.isYeargodDuty) {
                _maxPowerGodList.unshift('岁德合');
            }
            const isDeSheEnSixiang = _maxPowerGodList.some(g => gbDic.goodName.includes(g));
            if (isDeSheEnSixiang && thingLevel !== 2) {
                this.badThing = rfRemove(this.badThing, ['进人口', '安床', '经络', '酝酿', '开市', '立券交易', '纳财', '开仓库', '出货财']);
                this.badThing = rfAdd(this.badThing, deIsBadThing);
            }
            //# 凡天狗寅日忌祭祀，不注宜求福、祈嗣。
            if (gbDic.badName.includes('天狗') || d.includes('寅')) {
                this.badThing = rfAdd(this.badThing, ['祭祀']);
                this.goodThing = rfRemove(this.goodThing, ['祭祀', '求福', '祈嗣']);
            }

            //# 凡卯日忌穿井，不注宜开渠。壬日忌开渠，不注宜穿井。
            if (d.includes('卯')) { this.badThing = rfAdd(this.badThing, ['穿井']); this.goodThing = rfRemove(this.goodThing, ['穿井', '开渠']); }
            if (d.includes('壬')) { this.badThing = rfAdd(this.badThing, ['开渠']); this.goodThing = rfRemove(this.goodThing, ['开渠', '穿井']); }
            //# 凡巳日忌出行，不注宜出师、遣使。
            if (d.includes('巳')) { this.badThing = rfAdd(this.badThing, ['出行']); this.goodThing = rfRemove(this.goodThing, ['出行', '出师', '遣使']); }
            //# 凡酉日忌宴会，亦不注宜庆赐、赏贺。
            if (d.includes('酉')) { this.badThing = rfAdd(this.badThing, ['宴会']); this.goodThing = rfRemove(this.goodThing, ['宴会', '庆赐', '赏贺']); }
            //# 凡丁日忌剃头，亦不注宜整容。
            if (d.includes('丁')) { this.badThing = rfAdd(this.badThing, ['剃头']); this.goodThing = rfRemove(this.goodThing, ['剃头', '整容']); }
            //# 凡吉足胜凶，从宜不从忌者，如遇德犹忌之事，则仍注忌。
            if (this.todayLevel === 0 && thingLevel === 0) this.badThing = rfAdd(this.badThing, deIsBadThing);
            //# 凡吉凶相抵，不注宜亦不注忌者，如遇德犹忌之事，则仍注忌。
            if (this.todayLevel === 1) {
                this.badThing = rfAdd(this.badThing, deIsBadThing);
                //# 凡吉凶相抵，不注忌祈福，亦不注忌求嗣。
                if (!this.badThing.includes('祈福')) this.badThing = rfRemove(this.badThing, ['求嗣']);
                //# 凡吉凶相抵，不注忌结婚姻，亦不注忌冠带、纳采问名、嫁娶、进人口，如遇德犹忌之日则仍注忌。
                if (!this.badThing.includes('结婚姻') && !this.isDe) this.badThing = rfRemove(this.badThing, ['冠带', '纳采问名', '嫁娶', '进人口']);
                //# 凡吉凶相抵，不注忌嫁娶，亦不注忌冠带、结婚姻、纳采问名、进人口、搬移、安床，如遇德犹忌之日，则仍注忌。
                if (!this.badThing.includes('嫁娶') && !this.isDe) {
                    if (!gbDic.goodName.includes('不将')) this.badThing = rfRemove(this.badThing, ['冠带', '纳采问名', '结婚姻', '进人口', '搬移', '安床']);
                }
            }
            //# 遇亥日、厌对、八专、四忌、四穷而仍注忌嫁娶者，只注所忌之事，其不忌者仍不注忌。【未妥善解决】
            if (d.includes('亥')) this.badThing = rfAdd(this.badThing, ['嫁娶']);
            //# 凡吉凶相抵，不注忌搬移，亦不注忌安床。不注忌安床，亦不注忌搬移。如遇德犹忌之日，则仍注忌。
            if (this.todayLevel === 1 && !this.isDe) {
                if (!this.badThing.includes('搬移')) this.badThing = rfRemove(this.badThing, ['安床']);
                if (!this.badThing.includes('安床')) this.badThing = rfRemove(this.badThing, ['搬移']);
                //# 凡吉凶相抵，不注忌解除，亦不注忌整容、剃头、整手足甲。如遇德犹忌之日，则仍注忌。
                if (!this.badThing.includes('解除')) this.badThing = rfRemove(this.badThing, ['整容', '剃头', '整手足甲']);
                //# 凡吉凶相抵，不注忌修造动土、竖柱上梁，亦不注忌修宫室、缮城郭、筑提防、修仓库、鼓铸、苫盖、修置产室、开渠穿井、安碓硙、补垣塞穴、修饰垣墙、平治道涂、破屋坏垣。如遇德犹忌之日，则仍注忌。
                if (!this.badThing.includes('修造') || !this.badThing.includes('竖柱上梁')) {
                    this.badThing = rfRemove(this.badThing, ['修宫室', '缮城郭', '整手足甲', '筑提', '修仓库', '鼓铸', '苫盖', '修置产室', '开渠穿井', '安碓硙', '补垣塞穴', '修饰垣墙', '平治道涂', '破屋坏垣']);
                }
            }
            if (this.todayLevel === 1) {
                //# 凡吉凶相抵，不注忌开市，亦不注忌立券交易、纳财。不注忌纳财，亦不注忌开市、立券交易。不注忌立券交易，亦不注忌开市、纳财。
                //# 凡吉凶相抵，不注忌开市、立券交易，亦不注忌开仓库、出货财。
                if (!this.badThing.includes('开市')) this.badThing = rfRemove(this.badThing, ['立券交易', '纳财', '开仓库', '出货财']);
                if (!this.badThing.includes('纳财')) this.badThing = rfRemove(this.badThing, ['立券交易', '开市']);
                if (!this.badThing.includes('立券交易')) this.badThing = rfRemove(this.badThing, ['纳财', '开市', '开仓库', '出货财']);
                //# 如遇专忌之日，则仍注忌。【未妥善解决】
                //# 凡吉凶相抵，不注忌牧养，亦不注忌纳畜。不注忌纳畜，亦不注忌牧养。
                if (!this.badThing.includes('牧养')) this.badThing = rfRemove(this.badThing, ['纳畜']);
                if (!this.badThing.includes('纳畜')) this.badThing = rfRemove(this.badThing, ['牧养']);
                 //# 凡吉凶相抵，有宜安葬不注忌启攒，有宜启攒不注忌安葬。
                if (this.goodThing.includes('安葬')) this.badThing = rfRemove(this.badThing, ['启攒']);
                if (this.goodThing.includes('启攒')) this.badThing = rfRemove(this.badThing, ['安葬']);
            }
            //# 凡忌诏命公卿、招贤，不注宜施恩、封拜、举正直、袭爵受封。    #本版本无 封拜 袭爵受封
            if (this.badThing.includes('诏命公卿') || this.badThing.includes('招贤')) this.goodThing = rfRemove(this.goodThing, ['施恩', '举正直']);
            //# 凡忌施恩、封拜、举正直、袭爵受封，亦不注宜诏命公卿、招贤。
            if (this.badThing.includes('施恩') || this.badThing.includes('举正直')) this.goodThing = rfRemove(this.goodThing, ['诏命公卿', '招贤']);
            //# 凡宜宣政事之日遇往亡则改宣为布。
            if (this.goodThing.includes('宣政事') && gbDic.badName.includes('往亡')) { this.goodThing = rfRemove(this.goodThing, ['宣政事']); this.goodThing = rfAdd(this.goodThing, ['布政事']); }
            // # 凡月厌忌行幸、上官，不注宜颁诏、施恩封拜、诏命公卿、招贤、举正直。遇宜宣政事之日，则改宣为布。
            if (gbDic.badName.includes('月厌')) {
                this.goodThing = rfRemove(this.goodThing, ['颁诏', '施恩', '招贤', '举正直', '宣政事']); this.goodThing = rfAdd(this.goodThing, ['布政事']);
                this.badThing = rfAdd(this.badThing, ['补垣']);
                if (['土府', '土符', '地囊'].some(val => gbDic.badName.includes(val))) this.goodThing = rfRemove(this.goodThing, ['塞穴']);
            }
             //# 凡开日，不注宜破土、安葬、启攒，亦不注忌。遇忌则注。
            if (o.includes('开')) this.goodThing = rfRemove(this.goodThing, ['破土', '安葬', '启攒']);
            //# 凡四忌、四穷只忌安葬。如遇鸣吠、鸣吠对亦不注宜破土、启攒。
            if (gbDic.badName.includes('四忌') || gbDic.badName.includes('四穷')) { this.badThing = rfAdd(this.badThing, ['安葬']); this.goodThing = rfRemove(this.goodThing, ['破土', '启攒']); }
            if (gbDic.goodName.includes('鸣吠') || gbDic.goodName.includes('鸣吠对')) this.goodThing = rfRemove(this.goodThing, ['破土', '启攒']);

            //# 凡天吏、大时不以死败论者，遇四废、岁薄、逐阵仍以死败论。
            //# 凡岁薄、逐阵日所宜事，照月厌所忌删，所忌仍从本日。、
            //# 二月甲戌、四月丙申、六月甲子、七月戊申、八月庚辰、九月辛卯、十月甲子、十二月甲子，德和与赦、愿所汇之辰，诸事不忌。
            const deHeDayList = ['空', '甲戌', '空', '丙申', '空', '甲子', '戊申', '庚辰', '辛卯', '甲子', '空', '甲子'];
            if (deHeDayList[lmn - 1] === d) { // 此处 d 为 2 字全柱字符串，OK
                this.badThing = ['诸事不忌'];
            }
            if (['岁德合', '月德合', '天德合'].some(val => gbDic.goodName.includes(val)) && ['天赦', '天愿'].some(val => gbDic.goodName.includes(val))) this.badThing = ['诸事不忌'];
        }

        // 7. 最终清理
        //# 书中未明注忌不注宜
        let rmFinal = this.badThing.filter(thing => this.goodThing.includes(thing));
        if (!(rmFinal.length === 1 && rmFinal[0].includes('诸事'))) this.goodThing = rfRemove(this.goodThing, rmFinal);
        if (this.badThing.length === 0) this.badThing = ['诸事不忌'];
        if (this.goodThing.length === 0) this.goodThing = ['诸事不宜'];

        this.goodThing.sort((a, b) => sortCollation(a) - sortCollation(b));
        this.badThing.sort((a, b) => sortCollation(a) - sortCollation(b));
        this.goodGodName = gbDic.goodName;
        this.badGodName = gbDic.badName;

        return [this.goodGodName, this.badGodName];
    }
}
