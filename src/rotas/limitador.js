'use strict';
// Limita tentativas de login: 8 por 15 minutos por IP.
const janela = 15 * 60 * 1000;
const tentativas = new Map();
module.exports = function limitador(req, res, next) {
  const k = req.ip;
  const agora = Date.now();
  const lista = (tentativas.get(k) || []).filter((t) => agora - t < janela);
  if (lista.length >= 8) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  lista.push(agora); tentativas.set(k, lista);
  next();
};
