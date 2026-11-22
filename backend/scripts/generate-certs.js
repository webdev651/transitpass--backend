'use strict';
/* Generate self-signed certificates for local HTTPS development.
   Run: node scripts/generate-certs.js
   This creates backend/certs/local-ca.pem, backend/certs/local-cert.pem, backend/certs/local-key.pem
   For mobile trust: install backend/certs/local-ca.pem on your Android device (Settings > Security > Encryption & credentials > Install a certificate > CA certificate). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CERTS_DIR = path.join(__dirname, '..', 'certs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function generateCerts() {
  ensureDir(CERTS_DIR);

  const caKeyPath = path.join(CERTS_DIR, 'local-ca-key.pem');
  const caCertPath = path.join(CERTS_DIR, 'local-ca.pem');
  const certPath = path.join(CERTS_DIR, 'local-cert.pem');
  const keyPath = path.join(CERTS_DIR, 'local-key.pem');

  // Check if already exists
  if (fs.existsSync(caKeyPath) && fs.existsSync(caCertPath) && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    console.log('Certificates already exist. Delete them first to regenerate.');
    console.log(`  CA Key: ${caKeyPath}`);
    console.log(`  CA Cert: ${caCertPath}`);
    console.log(`  Server Cert: ${certPath}`);
    console.log(`  Server Key: ${keyPath}`);
    return;
  }

  console.log('Generating local CA and server certificate...');

  // Generate CA key pair
  const caKeyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // Create CA certificate
  const caCert = createCertificate({
    subject: { commonName: 'TransitPass Local CA' },
    issuer: { commonName: 'TransitPass Local CA' },
    publicKey: caKeyPair.publicKey,
    privateKey: caKeyPair.privateKey,
    isCA: true,
    days: 3650 // 10 years
  });

  fs.writeFileSync(caKeyPath, caKeyPair.privateKey);
  fs.writeFileSync(caCertPath, caCert);
  console.log(`Created CA: ${caCertPath}`);
  console.log(`Created CA Key: ${caKeyPath}`);

  // Generate server key pair
  const serverKeyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // Get local IPs for SAN
  const os = require('os');
  const ips = ['127.0.0.1', 'localhost'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) ips.push(i.address);
    }
  }

  // Create server certificate signed by CA
  const serverCert = createCertificate({
    subject: { commonName: 'TransitPass Local Server' },
    issuer: { commonName: 'TransitPass Local CA' },
    publicKey: serverKeyPair.publicKey,
    privateKey: caKeyPair.privateKey, // signed by CA
    isCA: false,
    days: 825, // ~2.25 years (max for some browsers)
    altNames: ips
  });

  fs.writeFileSync(keyPath, serverKeyPair.privateKey);
  fs.writeFileSync(certPath, serverCert);
  console.log(`Created Server Cert: ${certPath}`);
  console.log(`Created Server Key: ${keyPath}`);

  console.log('\n--- Next Steps ---');
  console.log('1. Start the HTTPS server: npm run dev:https');
  console.log('2. On your Android phone:');
  console.log('   a. Transfer backend/certs/local-ca.pem to your phone');
  console.log('   b. Settings > Security & privacy > More security & privacy > Install certificates > CA certificate');
  console.log('   c. Select the local-ca.pem file');
  console.log('   d. Name it "TransitPass Local CA"');
  console.log('3. Access https://<your-pc-ip>:3443/driver-dashboard.html on your phone');
  console.log('\nNote: If using mkcert (recommended), run: mkcert -install && mkcert localhost 127.0.0.1 <your-ip>');
}

function createCertificate({ subject, issuer, publicKey, privateKey, isCA, days, altNames = [] }) {
  const forge = require('node-forge');

  const keys = forge.pki.publicKeyFromPem(publicKey);
  const privKey = forge.pki.privateKeyFromPem(privateKey);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notAfter.getDate() + days);

  const attrs = [
    { name: 'commonName', value: subject.commonName }
  ];
  cert.setSubject(attrs);

  const issuerAttrs = [
    { name: 'commonName', value: issuer.commonName }
  ];
  cert.setIssuer(issuerAttrs);

  if (isCA) {
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
      { name: 'subjectKeyIdentifier' }
    ]);
  } else {
    const exts = [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectKeyIdentifier' }
    ];

    if (altNames.length > 0) {
      const san = altNames.map(ip => ({ type: ip.match(/^\d+\.\d+\.\d+\.\d+$/) ? 7 : 2, value: ip }));
      exts.push({ name: 'subjectAltName', altNames: san });
    }

    cert.setExtensions(exts);
  }

  cert.sign(privKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

if (require.main === module) {
  try {
    require('node-forge');
    generateCerts();
  } catch (e) {
    console.error('node-forge is required. Install it with: npm install node-forge --save-dev');
    console.log('Then run: node scripts/generate-certs.js');
    process.exit(1);
  }
}

module.exports = { generateCerts };