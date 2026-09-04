const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Resend } = require('resend');
const db = require('./database');
require('dotenv').config();

const app = express();

// Permite identificar o IP real do cliente atrás do proxy reverso do Render / Cloudflare
app.set('trust proxy', 1);

app.use(express.json());

const allowedOrigins = [
    'https://luxeformllcfl.com',
    'http://luxeformllcfl.com',
    'https://www.luxeformllcfl.com',
    'http://www.luxeformllcfl.com',
    'https://luxeform-front.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        // Permite requisições sem origin (como mobile apps, curl, postman)
        if (!origin) return callback(null, true);

        // Permite origens da lista, portas localhost/127.0.0.1 (ex: Live Server 5500) e deploys da Vercel
        const isAllowed = allowedOrigins.includes(origin) ||
            /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
            /^https:\/\/.*\.vercel\.app$/.test(origin);

        if (isAllowed) {
            return callback(null, true);
        }
        return callback(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

// Trava de Segurança Anti-Spam (Máximo 3 requisições por minuto por IP)
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP, please try again later.' }
});

// Inicializa a Resend com a chave da variável de ambiente
const resend = new Resend(process.env.RESEND_API_KEY);

// Endpoint Único de Orçamento
app.post('/api/estimates', limiter, async (req, res) => {
    const { fullName, email, phoneNumber, service, projectDetails } = req.body;

    if (!fullName || !email || !phoneNumber) {
        return res.status(400).json({ error: 'Required fields are missing.' });
    }

    try {
        // 1️⃣ Salvar no Banco de Dados
        const queryText = `
            INSERT INTO tb_estimates (full_name, email, phone_number, service_type, project_details)
            VALUES (?, ?, ?, ?, ?) 
        `;

        const values = [fullName, email, phoneNumber, service || 'General Inquiry', projectDetails || ''];
        const [result] = await db.query(queryText, values);
        const leadId = result.insertId;

        // 2️⃣ Formatação inteligente do telefone para o WhatsApp
        let cleanPhone = phoneNumber.replace(/\D/g, '');
        if (cleanPhone.length === 10) {
            cleanPhone = '1' + cleanPhone; // EUA (+1)
        } else if (cleanPhone.length === 11 && !cleanPhone.startsWith('55')) {
            cleanPhone = '55' + cleanPhone; // Brasil (+55) para testes
        }

        // 3️⃣ Link com texto pré-definido para abrir o WhatsApp do lead
        const whatsappText = encodeURIComponent(
            `Hi ${fullName}, thank you for contacting LuxeForm Remodeling! ` +
            `We received your request for the "${service || 'Custom'}" project. Let's schedule your consultation?`
        );
        const whatsappUrl = `https://wa.me/${cleanPhone}?text=${whatsappText}`;

        // 4️⃣ Configuração do Remetente e Destinatário
        // No Resend, o "from" deve ser 'onboarding@resend.dev' até que o domínio próprio esteja verificado na plataforma.
        // Remetente oficial com o domínio verificado
        const sender = 'LuxeForm Remodeling <noreply@luxeformllcfl.com>';

        // Destinatário final (a caixa de entrada da empresa)
        const recipient = 'Luxeform.llc@gmail.com';

        await resend.emails.send({
            from: sender,
            replyTo: email,
            to: recipient,
            subject: `New Estimate Request #${leadId} - ${fullName} (${service || 'General'})`,
            text: `New Estimate Request #${leadId}\n\n` +
                `Name: ${fullName}\n` +
                `Email: ${email}\n` +
                `Phone: ${phoneNumber}\n` +
                `Service: ${service}\n` +
                `Project Details:\n${projectDetails || 'No details provided.'}\n\n` +
                `Reply via WhatsApp: ${whatsappUrl}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
                    <h2 style="color: #8B1E2F; border-bottom: 2px solid #8B1E2F; padding-bottom: 10px;">New Estimate Request #${leadId}</h2>
                    
                    <p><strong>Name:</strong> ${fullName}</p>
                    <p><strong>Email:</strong> ${email}</p>
                    <p><strong>Phone:</strong> ${phoneNumber}</p>
                    <p><strong>Service Type:</strong> ${service || 'Not specified'}</p>
                    <p><strong>Project Details:</strong></p>
                    <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #8B1E2F; margin-bottom: 25px; border-radius: 4px;">
                        ${projectDetails || 'No details provided.'}
                    </div>

                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${whatsappUrl}" target="_blank" style="background-color: #25D366; color: white; text-decoration: none; padding: 14px 25px; font-weight: bold; border-radius: 5px; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                            💬 Reply via WhatsApp
                        </a>
                    </div>
                    
                    <hr style="border: 0; border-top: 1px solid #e0e0e0; margin-top: 30px;">
                    <p style="font-size: 12px; color: #777; text-align: center;">Automated notification from LuxeForm Landing Page.</p>
                </div>
            `,
        });

        if (resendError) {
            console.error('Erro retornado pela API do Resend:', resendError);
            return res.status(500).json({ error: 'Failed to send notification email.' });
        }

        return res.status(200).json({
            message: 'Thank you! Your estimate request has been submitted successfully. LuxeForm Remodeling has received your project details, and you will receive a WhatsApp message shortly to continue the conversation.'
        });

    } catch (error) {
        console.error('Database/Server Error:', error);
        return res.status(500).json({ error: 'Internal error processing request.' });
    }
});

// Middleware de tratamento de erros global
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));