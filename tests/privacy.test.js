const request = require('supertest');
const { createApp } = require('../src/app');

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
});
