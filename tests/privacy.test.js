const request = require('supertest');
const { createApp } = require('../src/app');

afterEach(() => {
  delete process.env.PRIVACY_CONTACT;
});

describe('privacy policy page', () => {
  it('serves the policy with the configured contact', async () => {
    process.env.PRIVACY_CONTACT = 'privacidade@dinblu.test';
    const res = await request(createApp()).get('/privacidade');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Política de Privacidade');
    expect(res.text).toContain('privacidade@dinblu.test');
    expect(res.text).not.toContain('{{CONTACT}}');
  });

  it('defaults the contact to contato@dinblu.com.br', async () => {
    const res = await request(createApp()).get('/privacidade');
    expect(res.text).toContain('contato@dinblu.com.br');
  });
});

describe('delete account page', () => {
  it('is public and lists the steps', async () => {
    const res = await request(createApp()).get('/excluir-conta');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Excluir conta');
    expect(res.text).toContain('contato@dinblu.com.br');
    expect(res.text).not.toContain('{{CONTACT}}');
  });
});
