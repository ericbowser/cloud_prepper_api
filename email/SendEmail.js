const nodemailer = require('nodemailer');
const config = require('../env.json');
const sgMail = require('@sendgrid/mail')
sgMail.setApiKey('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');
console.log(process.env.SENDGRID_API_KEY)

const sendGridEmail = async ({from, subject, message}) => {
  const msg = {
    to: 'laser@new-collar.space', // Change to your recipient
    from: from || 'ericryanbowser@gmail.com', // Change to your verified sender
    subject: subject,
    text: message,
    html: '<strong>and easy to do anywhere, even with Node.js</strong>'
  }
  try {
    await sgMail.send(msg);
    return 1;
  }
  catch (error) {
    console.error(error);
    return -1;
  }
}

const sendEmailWithAttachment = async (from, to, subject, message) => {
  const transporter = await nodemailer.createTransport({
    to: to,
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: 'ericryanbowser@gmail.com',
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

module.exports = {sendEmailWithAttachment, sendGridEmail};