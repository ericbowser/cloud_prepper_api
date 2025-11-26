const nodemailer = require('nodemailer');
const config = require('../env.json');

const sendEmailWithAttachment = async (from, to, subject, message) => {
  const transporter = await nodemailer.createTransport({
    to: to,
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: '',
      pass: config.GMAIL_APP_PASSWORD,
    },
  });
  const info = await transporter.sendMail({
    from: from,
    to: to,
    subject: subject,
    text: message,
    html:
      `<div>
            <h6>Received message from ${from}</h6>
            <p>
                ${message}
            </p>
      </div>
      `
  });
  console.log("Message sent: %s", info.messageId);
  return info.messageId;
}


module.exports = {sendEmailWithAttachment};
