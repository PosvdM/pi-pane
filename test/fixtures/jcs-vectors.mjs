// RFC 8785 中的测试数据，浏览器和 Node.js 共用。

// 附录 B：IEEE 754 位模式 → 期望输出；null 表示必须报错（NaN、Infinity）。
export const NUMBER_VECTORS = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['7fffffffffffffff', null],
  ['7ff0000000000000', null],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
];

export function hexToDouble(hex) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt('0x' + hex));
  return dv.getFloat64(0);
}

// 第 3.2.2 节的示例（输入为 JSON 文本，期望输出为规范 JSON 文本）。
export const SAMPLE_INPUT =
  '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
  ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
  ' "literals": [null, true, false]}';
export const SAMPLE_OUTPUT =
  '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
  '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';

// 第 3.2.3 节的排序示例，期望的键顺序。
export const SORT_INPUT =
  '{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh",' +
  ' "1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control",' +
  ' "\\u00f6": "Latin Small Letter O With Diaeresis"}';
// 不能用 Object.keys 读回顺序：整数形式的键（"1"）总被引擎排在最前。所以直接拼出期望文本。
export const SORT_EXPECTED_OUTPUT =
  '{' +
  [
    ['\r', 'Carriage Return'],
    ['1', 'One'],
    ['\u0080', 'Control'],
    ['\u00f6', 'Latin Small Letter O With Diaeresis'],
    ['\u20ac', 'Euro Sign'],
    ['\ud83d\ude00', 'Emoji: Grinning Face'],
    ['\ufb33', 'Hebrew Letter Dalet With Dagesh'],
  ]
    .map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v))
    .join(',') +
  '}';

/** 在当前 JS 引擎上跑全部向量，返回失败列表。 */
export function runJcsVectors(canonicalize) {
  const failures = [];
  for (const [hex, expected] of NUMBER_VECTORS) {
    const d = hexToDouble(hex);
    let got;
    try {
      got = canonicalize(d);
    } catch {
      got = null;
    }
    if (got !== expected) failures.push({ hex, expected, got });
  }
  const sample = canonicalize(JSON.parse(SAMPLE_INPUT));
  if (sample !== SAMPLE_OUTPUT) failures.push({ case: 'sample', expected: SAMPLE_OUTPUT, got: sample });
  const sorted = canonicalize(JSON.parse(SORT_INPUT));
  if (sorted !== SORT_EXPECTED_OUTPUT) {
    failures.push({ case: 'sort', expected: SORT_EXPECTED_OUTPUT, got: sorted });
  }
  for (const bad of [NaN, Infinity, undefined, () => 1, 1n, '\ud800', { a: undefined }]) {
    let threw = false;
    try {
      canonicalize(bad);
    } catch {
      threw = true;
    }
    if (!threw) failures.push({ case: 'must-throw', value: String(bad) });
  }
  return failures;
}

/** 签名实验用的“刁钻”payload：RFC 向量里的数字、需要排序的键、需要转义的字符串。 */
export function trickyPayload() {
  return {
    action: 'agora.request.answer',
    target: 'rq_31c0',
    nested: JSON.parse(SORT_INPUT),
    numbers: NUMBER_VECTORS.filter(([, e]) => e !== null).map(([h]) => hexToDouble(h)),
    sample: JSON.parse(SAMPLE_INPUT),
    text: '中文 “引号” \u2028\u2029 \t\u0000 😀',
    empty: { a: [], b: {} },
  };
}
