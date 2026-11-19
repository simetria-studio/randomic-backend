module.exports = async () => {
  if (globalThis.__PG__) await globalThis.__PG__.stop();
};
