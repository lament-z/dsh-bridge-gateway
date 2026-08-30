// 零依赖自签证书生成器（IP 直连场景适用）
// 仅用 Node 内置 crypto：RSA 密钥对 + DER 编码一张最基本的自签 X.509 v3 证书。
// 无需 openssl 命令行、无需额外 npm 依赖，可在 macOS / Linux / Windows 开箱生成 TLS 证书。
//
// 注意：个人远程访问（IP 直连）使用本证书时，浏览器首次会提示"证书无效/不安全"，
// 用户需选择"继续前往"。若要彻底消除告警，请在网关配置区上传域名/权威证书。

import { dirname } from 'node:path';
import {
  generateKeyPairSync,
  sign,
  randomBytes,
} from 'node:crypto';

// --- 最小 ASN.1 DER 编码助手 ---

function len(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag, content) {
  return [tag, ...len(content.length), ...content];
}

function integerBytes(bytes) {
  if (bytes.length && (bytes[0] & 0x80)) bytes = [0, ...bytes];
  return tlv(0x02, bytes);
}

function oid(oidArr) {
  let body = [40 * oidArr[0] + oidArr[1]];
  for (let i = 2; i < oidArr.length; i++) {
    let v = oidArr[i];
    let sub = [];
    if (v === 0) {
      sub = [0];
    } else {
      while (v > 0) {
        sub.unshift(v & 0x7f);
        v >>>= 7;
      }
      for (let j = 0; j < sub.length - 1; j++) sub[j] |= 0x80;
    }
    body.push(...sub);
  }
  return tlv(0x06, body);
}

function nullValue() {
  return tlv(0x05, []);
}

function printableString(str) {
  return tlv(0x13, [...Buffer.from(str, 'utf8')]);
}

function bitString(bytes) {
  return tlv(0x03, [0, ...bytes]);
}

function octetString(...bytes) {
  return tlv(0x04, bytes.flat());
}

function sequence(...inner) {
  return tlv(0x30, inner.flat());
}

function setOf(...inner) {
  return tlv(0x31, inner.flat());
}

function utcTimeStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (d.getUTCFullYear() % 100).toString().padStart(2, '0') +
    p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}

function toPem(der, type) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${type}-----\n${b64}\n-----END ${type}-----\n`;
}

/**
 * 生成单张可被浏览器接受的 IP / 域名自签证书。
 * 关键点：subjectAltName 必须包含浏览器访问所用的宿主（IP 或域名）。
 */
export function generateSelfSignedCert({
  commonName = 'dsh-bridge-gateway',
  subjectAltNames = ['localhost', '127.0.0.1', '::1'],
  days = 825,
} = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyObj = privateKey; // generateKeyPairSync 返回的已是 PrivateKeyObject，可直接用于签名
  const pubObject = publicKey; // 同理：已是公钥 KeyObject
  const derSpki = pubObject.export({ type: 'spki', format: 'der' });

  // 从 SPKI DER 提取公钥 BIT STRING 内容
  const spki = parseTlvs(derSpki);
  // spki: [0]=SEQUENCE(AlgorithmIdentifier, BIT STRING)
  const spkiSeq = parseTlvs(spki[0].content);
  const pubBitString = spkiSeq[1].content.subarray(1); // 跳过第一个 0x00

  const now = Date.now();
  const notBefore = new Date(now - 60 * 60 * 1000);
  const notAfter = new Date(now + days * 24 * 3600 * 1000);

  // subjectAltName (GeneralNames)：dNSName [2] IMPLICIT IA5String / iPAddress [7] IMPLICIT OCTET STRING
  // 每个 GeneralName 都是 context-specific 标签，必须带长度前缀（首次手写漏了长度导致 X509 "wrong tag"）。
  const sanValues = [];
  for (const name of subjectAltNames) {
    if (isIpv4(name)) {
      sanValues.push(tlv(0x87, name.split('.').map((n) => parseInt(n, 10))));
    } else if (name === '::1') {
      const raw = Buffer.alloc(16);
      raw[15] = 1;
      sanValues.push(tlv(0x87, [...raw]));
    } else {
      sanValues.push(tlv(0x82, [...Buffer.from(name, 'utf8')]));
    }
  }

  const extensions = sequence(
    // basicConstraints: critical CA:FALSE —— 值为空 SEQUENCE `30 00`
    sequence(oid([2, 5, 29, 19]), octetString(...sequence(...[]))),
    // subjectAltName
    sequence(oid([2, 5, 29, 17]), octetString(...sequence(...sanValues))),
  );

  const tbs = sequence(
    tlv(0xa0, integerTlv(2)), // version [0] EXPLICIT Version = v3
    integerBytes([...randomBytes(16)]), // serial
    sequence(oid([1, 2, 840, 113549, 1, 1, 11]), nullValue()), // sha256WithRSA 算法
    sequence(setOf(sequence(oid([2, 5, 4, 3]), printableString(commonName)))), // issuer
    sequence(
      tlv(0x17, [...Buffer.from(utcTimeStr(notBefore), 'ascii')]),
      tlv(0x17, [...Buffer.from(utcTimeStr(notAfter), 'ascii')]),
    ),
    sequence(setOf(sequence(oid([2, 5, 4, 3]), printableString(commonName)))), // subject
    sequence(
      // SubjectPublicKeyInfo
      sequence(oid([1, 2, 840, 113549, 1, 1, 1]), nullValue()),
      bitString([...pubBitString]),
    ),
    tlv(0xa3, extensions), // [3] extensions
  );

  const algorithm = sequence(oid([1, 2, 840, 113549, 1, 1, 11]), nullValue());
  const sig = sign('sha256', Buffer.from(tbs), keyObj);
  const certDer = sequence(tbs, algorithm, bitString([...sig]));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: toPem(certDer, 'CERTIFICATE'),
  };
}

// --- DER 解析（用于从 SPKI 提取公钥；返回元素数组，元素 {content: Buffer}，忽略不用的 tag） ---
function parseTlvs(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i++];
    let n = buf[i++];
    if (n & 0x80) {
      const c = n & 0x7f;
      n = 0;
      for (let k = 0; k < c; k++) n = (n << 8) | buf[i++];
    }
    out.push({ tag, content: buf.subarray(i, i + n) });
    i += n;
  }
  return out;
}

function integerTlv(n) {
  return tlv(0x02, [n]);
}

function isIpv4(str) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(str);
}

/**
 * 读取已缓存自签证书，否则生成并持久化到 DSH_HOME/dsh-bridge/certs/。
 */
export async function getOrCreateSelfSignedCert({ certFile, keyFile, logger }) {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  try {
    const [cert, key] = await Promise.all([
      readFile(certFile, 'utf8'),
      readFile(keyFile, 'utf8'),
    ]);
    if (cert && key) return { cert, key };
  } catch {}
  const { cert, key } = generateSelfSignedCert();
  try {
    await mkdir(dirname(certFile), { recursive: true });
    await Promise.all([
      writeFile(certFile, cert, 'utf8'),
      writeFile(keyFile, key, 'utf8'),
    ]);
  } catch (err) {
    logger?.warn?.('dsh-bridge: 无法持久化自签证书: %s', err?.message ?? err);
  }
  return { cert, key };
}