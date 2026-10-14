'use strict';
const crypto = require('crypto');

const SECRET = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('Defina SESSION_SECRET (mínimo 16 caracteres) no ambiente');
  return s;
};

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(senha), salt, 64).toString('hex');
  return `${salt}:${h}`;
}
function conferirSenha(senha, armazenado) {
  if (!armazenado) return false;
  const [salt, h] = armazenado.split(':');
  const calc = crypto.scryptSync(String(senha), salt, 64);
  const ref = Buffer.from(h, 'hex');
  return ref.length === calc.length && crypto.timingSafeEqual(ref, calc);
}

function assinar(payload, horas = 12) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + horas * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function validar(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const esperado = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!p.exp || p.exp < Date.now()) return null;
  return p;
}

function lerCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function definirCookie(res, nome, valor, horas) {
  const seguro = process.env.COOKIE_SECURE === 'false' ? '' : '; Secure';
  res.append('Set-Cookie', `${nome}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(horas * 3600)}${seguro}`);
}
function limparCookie(res, nome) { res.append('Set-Cookie', `${nome}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }

// Painel: perfis validados no servidor.
function exigirPainel(...perfis) {
  return (req, res, next) => {
    const p = validar(lerCookies(req).pulse_admin);
    if (!p || p.tipo !== 'painel') return res.status(401).json({ erro: 'Faça login' });
    if (perfis.length && !perfis.includes(p.perfil)) return res.status(403).json({ erro: 'Sem permissão para esta ação' });
    req.usuario = p; next();
  };
}
function exigirColaborador(req, res, next) {
  const p = validar(lerCookies(req).pulse_app);
  if (!p || p.tipo !== 'colaborador') return res.status(401).json({ erro: 'Faça login' });
  req.colab = p; next();
}

module.exports = { hashSenha, conferirSenha, assinar, validar, lerCookies, definirCookie, limparCookie, exigirPainel, exigirColaborador };
