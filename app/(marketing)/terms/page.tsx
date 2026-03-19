import type { Metadata } from 'next';
import Box from '@mui/material/Box';
import LegalPageContainer from '@/components/marketing/LegalPageContainer';

export const metadata: Metadata = {
  title: 'Terms of Service – Jigged',
  description: 'Jigged Terms of Service for precision manufacturing ERP.',
};

export default function TermsPage() {
  return (
    <LegalPageContainer>
      <Box
        sx={{
          '& .last-updated': {
            fontSize: 14,
            color: '#6b7280',
            mb: 6,
            pb: 3,
            borderBottom: '1px solid rgba(70, 130, 180, 0.2)',
          },
          '& .toc': {
            my: 4,
            p: 3,
            background: 'rgba(70, 130, 180, 0.06)',
            border: '1px solid rgba(70, 130, 180, 0.12)',
            borderRadius: 2,
          },
          '& .toc ol': { m: 0, pl: 2.5 },
          '& .toc li': { mb: 0.75 },
          '& .toc a': { color: '#4682B4', fontSize: 14 },
          '& .disclaimer-block': {
            fontSize: 13,
            lineHeight: 1.6,
            color: '#9ca3af',
            textTransform: 'uppercase',
          },
          '& .contact-block': {
            mt: 2,
            p: 2.5,
            background: 'rgba(70, 130, 180, 0.06)',
            border: '1px solid rgba(70, 130, 180, 0.12)',
            borderRadius: 2,
            '& p': { mb: 0.5 },
          },
          '& .section-divider': {
            border: 'none',
            borderTop: '1px solid rgba(70, 130, 180, 0.1)',
            my: 5,
          },
        }}
        dangerouslySetInnerHTML={{
          __html: `
    <h1>Terms of Service</h1>
    <p class="last-updated">Last updated: March 18, 2026</p>

    <h2>Agreement to Our Legal Terms</h2>
    <p>We are Jigged ("<strong>Company</strong>," "<strong>we</strong>," "<strong>us</strong>," "<strong>our</strong>").</p>
    <p>We operate the website <a href="https://jigged.app">jigged.app</a>, as well as any other related products and services that refer or link to these legal terms (the "<strong>Legal Terms</strong>") (collectively, the "<strong>Services</strong>").</p>
    <p>You can contact us by email at <a href="mailto:legal@jigged.app">legal@jigged.app</a>.</p>
    <p>These Legal Terms constitute a legally binding agreement made between you, whether personally or on behalf of an entity ("<strong>you</strong>"), and Jigged, concerning your access to and use of the Services. You agree that by accessing the Services, you have read, understood, and agreed to be bound by all of these Legal Terms. IF YOU DO NOT AGREE WITH ALL OF THESE LEGAL TERMS, THEN YOU ARE EXPRESSLY PROHIBITED FROM USING THE SERVICES AND YOU MUST DISCONTINUE USE IMMEDIATELY.</p>
    <p>Supplemental terms and conditions or documents that may be posted on the Services from time to time are hereby expressly incorporated herein by reference. We reserve the right, in our sole discretion, to make changes or modifications to these Legal Terms at any time and for any reason. We will alert you about any changes by updating the "Last updated" date of these Legal Terms, and you waive any right to receive specific notice of each such change. It is your responsibility to periodically review these Legal Terms to stay informed of updates. You will be subject to, and will be deemed to have been made aware of and to have accepted, the changes in any revised Legal Terms by your continued use of the Services after the date such revised Legal Terms are posted.</p>
    <p>We recommend that you print a copy of these Legal Terms for your records.</p>

    <div class="toc">
      <ol>
        <li><a href="#services">Our Services</a></li>
        <li><a href="#ip">Intellectual Property Rights</a></li>
        <li><a href="#representations">User Representations</a></li>
        <li><a href="#prohibited">Prohibited Activities</a></li>
        <li><a href="#ugc">User Generated Contributions</a></li>
        <li><a href="#license">Contribution License</a></li>
        <li><a href="#management">Services Management</a></li>
        <li><a href="#term">Term and Termination</a></li>
        <li><a href="#modifications">Modifications and Interruptions</a></li>
        <li><a href="#law">Governing Law</a></li>
        <li><a href="#disputes">Dispute Resolution</a></li>
        <li><a href="#corrections">Corrections</a></li>
        <li><a href="#disclaimer">Disclaimer</a></li>
        <li><a href="#liability">Limitations of Liability</a></li>
        <li><a href="#indemnification">Indemnification</a></li>
        <li><a href="#userdata">User Data</a></li>
        <li><a href="#electronic">Electronic Communications, Transactions, and Signatures</a></li>
        <li><a href="#miscellaneous">Miscellaneous</a></li>
        <li><a href="#contact">Contact Us</a></li>
      </ol>
    </div>

    <hr class="section-divider">

    <h2 id="services">1. Our Services</h2>
    <p>The information provided when using the Services is not intended for distribution to or use by any person or entity in any jurisdiction or country where such distribution or use would be contrary to law or regulation or which would subject us to any registration requirement within such jurisdiction or country. Accordingly, those persons who choose to access the Services from other locations do so on their own initiative and are solely responsible for compliance with local laws, if and to the extent local laws are applicable.</p>

    <hr class="section-divider">

    <h2 id="ip">2. Intellectual Property Rights</h2>
    <h3>Our Intellectual Property</h3>
    <p>We are the owner or the licensee of all intellectual property rights in our Services, including all source code, databases, functionality, software, website designs, audio, video, text, photographs, and graphics in the Services (collectively, the "Content"), as well as the trademarks, service marks, and logos contained therein (the "Marks").</p>
    <p>Our Content and Marks are protected by copyright and trademark laws (and various other intellectual property rights and unfair competition laws) and treaties around the world.</p>
    <p>The Content and Marks are provided in or through the Services "AS IS" for your personal, non-commercial use or internal business purpose only.</p>

    <h3>Your Use of Our Services</h3>
    <p>Subject to your compliance with these Legal Terms, including the "<a href="#prohibited">Prohibited Activities</a>" section below, we grant you a non-exclusive, non-transferable, revocable license to:</p>
    <ul>
      <li>access the Services; and</li>
      <li>download or print a copy of any portion of the Content to which you have properly gained access,</li>
    </ul>
    <p>solely for your personal, non-commercial use or internal business purpose.</p>
    <p>Except as set out in this section or elsewhere in our Legal Terms, no part of the Services and no Content or Marks may be copied, reproduced, aggregated, republished, uploaded, posted, publicly displayed, encoded, translated, transmitted, distributed, sold, licensed, or otherwise exploited for any commercial purpose whatsoever, without our express prior written permission.</p>
    <p>If you wish to make any use of the Services, Content, or Marks other than as set out in this section or elsewhere in our Legal Terms, please address your request to: <a href="mailto:legal@jigged.app">legal@jigged.app</a>. If we ever grant you the permission to post, reproduce, or publicly display any part of our Services or Content, you must identify us as the owners or licensors of the Services, Content, or Marks and ensure that any copyright or proprietary notice appears or is visible on posting, reproducing, or displaying our Content.</p>
    <p>We reserve all rights not expressly granted to you in and to the Services, Content, and Marks.</p>
    <p>Any breach of these Intellectual Property Rights will constitute a material breach of our Legal Terms and your right to use our Services will terminate immediately.</p>

    <h3>Your Submissions</h3>
    <p>Please review this section and the "<a href="#prohibited">Prohibited Activities</a>" section carefully prior to using our Services to understand the (a) rights you give us and (b) obligations you have when you post or upload any content through the Services.</p>
    <p><strong>Submissions:</strong> By directly sending us any question, comment, suggestion, idea, feedback, or other information about the Services ("Submissions"), you agree to assign to us all intellectual property rights in such Submission. You agree that we shall own this Submission and be entitled to its unrestricted use and dissemination for any lawful purpose, commercial or otherwise, without acknowledgment or compensation to you.</p>
    <p><strong>You are responsible for what you post or upload:</strong> By sending us Submissions through any part of the Services you:</p>
    <ul>
      <li>confirm that you have read and agree with our "<a href="#prohibited">Prohibited Activities</a>" and will not post, send, publish, upload, or transmit through the Services any Submission that is illegal, harassing, hateful, harmful, defamatory, obscene, bullying, abusive, discriminatory, threatening to any person or group, sexually explicit, false, inaccurate, deceitful, or misleading;</li>
      <li>to the extent permissible by applicable law, waive any and all moral rights to any such Submission;</li>
      <li>warrant that any such Submission are original to you or that you have the necessary rights and licenses to submit such Submissions and that you have full authority to grant us the above-mentioned rights in relation to your Submissions; and</li>
      <li>warrant and represent that your Submissions do not constitute confidential information.</li>
    </ul>
    <p>You are solely responsible for your Submissions and you expressly agree to reimburse us for any and all losses that we may suffer because of your breach of (a) this section, (b) any third party's intellectual property rights, or (c) applicable law.</p>

    <hr class="section-divider">

    <h2 id="representations">3. User Representations</h2>
    <p>By using the Services, you represent and warrant that: (1) you have the legal capacity and you agree to comply with these Legal Terms; (2) you are not a minor in the jurisdiction in which you reside; (3) you will not access the Services through automated or non-human means, whether through a bot, script, or otherwise; (4) you will not use the Services for any illegal or unauthorized purpose; and (5) your use of the Services will not violate any applicable law or regulation.</p>
    <p>If you provide any information that is untrue, inaccurate, not current, or incomplete, we have the right to suspend or terminate your account and refuse any and all current or future use of the Services (or any portion thereof).</p>

    <hr class="section-divider">

    <h2 id="prohibited">4. Prohibited Activities</h2>
    <p>You may not access or use the Services for any purpose other than that for which we make the Services available. The Services may not be used in connection with any commercial endeavors except those that are specifically endorsed or approved by us.</p>
    <p>As a user of the Services, you agree not to:</p>
    <ul>
      <li>Systematically retrieve data or other content from the Services to create or compile, directly or indirectly, a collection, compilation, database, or directory without written permission from us.</li>
      <li>Trick, defraud, or mislead us and other users, especially in any attempt to learn sensitive account information such as user passwords.</li>
      <li>Circumvent, disable, or otherwise interfere with security-related features of the Services.</li>
      <li>Disparage, tarnish, or otherwise harm, in our opinion, us and/or the Services.</li>
      <li>Use any information obtained from the Services in order to harass, abuse, or harm another person.</li>
      <li>Make improper use of our support services or submit false reports of abuse or misconduct.</li>
      <li>Use the Services in a manner inconsistent with any applicable laws or regulations.</li>
      <li>Engage in unauthorized framing of or linking to the Services.</li>
      <li>Upload or transmit viruses, Trojan horses, or other material that interferes with any party's use of the Services.</li>
      <li>Engage in any automated use of the system, such as using scripts to send comments or messages.</li>
      <li>Delete the copyright or other proprietary rights notice from any Content.</li>
      <li>Attempt to impersonate another user or person.</li>
      <li>Interfere with, disrupt, or create an undue burden on the Services.</li>
      <li>Harass, annoy, intimidate, or threaten any of our employees or agents.</li>
      <li>Attempt to bypass any measures designed to prevent or restrict access to the Services.</li>
      <li>Copy or adapt the Services' software.</li>
      <li>Except as permitted by applicable law, decipher, decompile, disassemble, or reverse engineer any software comprising the Services.</li>
      <li>Make any unauthorized use of the Services, including collecting usernames and/or email addresses for the purpose of sending unsolicited email.</li>
      <li>Use the Services as part of any effort to compete with us.</li>
    </ul>

    <hr class="section-divider">

    <h2 id="ugc">5. User Generated Contributions</h2>
    <p>The Services may provide you with the opportunity to create, submit, post, display, transmit, perform, publish, distribute, or broadcast content and materials to us or on the Services (collectively, "Contributions"). Contributions may be viewable by other users of the Services within the same company account. When you create or make available any Contributions, you thereby represent and warrant that:</p>
    <ul>
      <li>Your Contributions do not infringe the proprietary rights of any third party.</li>
      <li>You are the creator and owner of or have the necessary licenses and rights to your Contributions.</li>
      <li>You have the written consent of each identifiable individual person in your Contributions.</li>
      <li>Your Contributions are not false, inaccurate, or misleading.</li>
      <li>Your Contributions are not unsolicited advertising or spam.</li>
      <li>Your Contributions are not obscene, lewd, violent, harassing, or otherwise objectionable.</li>
      <li>Your Contributions do not violate any applicable law, regulation, or rule.</li>
      <li>Your Contributions do not violate the privacy or publicity rights of any third party.</li>
    </ul>
    <p>Any use of the Services in violation of the foregoing violates these Legal Terms and may result in termination or suspension of your rights to use the Services.</p>

    <hr class="section-divider">

    <h2 id="license">6. Contribution License</h2>
    <p>You and the Services agree that we may access, store, process, and use any information and personal data that you provide and your choices (including settings).</p>
    <p>By submitting suggestions or other feedback regarding the Services, you agree that we can use and share such feedback for any purpose without compensation to you.</p>
    <p>We do not assert any ownership over your Contributions. You retain full ownership of all of your Contributions and any intellectual property rights associated with your Contributions.</p>

    <hr class="section-divider">

    <h2 id="management">7. Services Management</h2>
    <p>We reserve the right, but not the obligation, to: (1) monitor the Services for violations of these Legal Terms; (2) take appropriate legal action against anyone who violates the law or these Legal Terms; (3) refuse, restrict access to, limit the availability of, or disable any of your Contributions; (4) remove from the Services files and content that are excessive in size or burdensome to our systems; and (5) otherwise manage the Services in a manner designed to protect our rights and property.</p>

    <hr class="section-divider">

    <h2 id="term">8. Term and Termination</h2>
    <p>These Legal Terms shall remain in full force and effect while you use the Services. WITHOUT LIMITING ANY OTHER PROVISION OF THESE LEGAL TERMS, WE RESERVE THE RIGHT TO, IN OUR SOLE DISCRETION AND WITHOUT NOTICE OR LIABILITY, DENY ACCESS TO AND USE OF THE SERVICES TO ANY PERSON FOR ANY REASON OR FOR NO REASON, INCLUDING WITHOUT LIMITATION FOR BREACH OF ANY REPRESENTATION, WARRANTY, OR COVENANT CONTAINED IN THESE LEGAL TERMS OR OF ANY APPLICABLE LAW OR REGULATION.</p>
    <p>If we terminate or suspend your account for any reason, you are prohibited from registering and creating a new account under your name, a fake or borrowed name, or the name of any third party.</p>

    <hr class="section-divider">

    <h2 id="modifications">9. Modifications and Interruptions</h2>
    <p>We reserve the right to change, modify, or remove the contents of the Services at any time or for any reason at our sole discretion without notice. We will not be liable to you or any third party for any modification, price change, suspension, or discontinuance of the Services.</p>
    <p>We cannot guarantee the Services will be available at all times. We may experience hardware, software, or other problems or need to perform maintenance related to the Services, resulting in interruptions, delays, or errors.</p>

    <hr class="section-divider">

    <h2 id="law">10. Governing Law</h2>
    <p>These Legal Terms shall be governed by and defined following the laws of the State of California, United States, and you irrevocably consent that the courts of the State of California shall have exclusive jurisdiction to resolve any dispute which may arise in connection with these Legal Terms.</p>

    <hr class="section-divider">

    <h2 id="disputes">11. Dispute Resolution</h2>
    <h3>Informal Negotiations</h3>
    <p>To expedite resolution and control the cost of any dispute, the Parties agree to first attempt to negotiate any Dispute informally for at least 30 days before initiating arbitration.</p>
    <h3>Binding Arbitration</h3>
    <p>Any dispute arising out of or in connection with these Legal Terms shall be referred to and finally resolved by binding arbitration administered by the American Arbitration Association ("AAA") under its Commercial Arbitration Rules. The seat of arbitration shall be San Jose, California, United States.</p>
    <h3>Restrictions</h3>
    <p>The Parties agree that any arbitration shall be limited to the Dispute between the Parties individually. No arbitration shall be joined with any other proceeding, and there is no right for any Dispute to be arbitrated on a class-action basis.</p>

    <hr class="section-divider">

    <h2 id="corrections">12. Corrections</h2>
    <p>There may be information on the Services that contains typographical errors, inaccuracies, or omissions. We reserve the right to correct any errors, inaccuracies, or omissions and to change or update the information on the Services at any time, without prior notice.</p>

    <hr class="section-divider">

    <h2 id="disclaimer">13. Disclaimer</h2>
    <p class="disclaimer-block">THE SERVICES ARE PROVIDED ON AN AS-IS AND AS-AVAILABLE BASIS. YOU AGREE THAT YOUR USE OF THE SERVICES WILL BE AT YOUR SOLE RISK. TO THE FULLEST EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, IN CONNECTION WITH THE SERVICES AND YOUR USE THEREOF, INCLUDING, WITHOUT LIMITATION, THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE MAKE NO WARRANTIES OR REPRESENTATIONS ABOUT THE ACCURACY OR COMPLETENESS OF THE SERVICES' CONTENT.</p>

    <hr class="section-divider">

    <h2 id="liability">14. Limitations of Liability</h2>
    <p class="disclaimer-block">IN NO EVENT WILL WE OR OUR DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE TO YOU OR ANY THIRD PARTY FOR ANY DIRECT, INDIRECT, CONSEQUENTIAL, EXEMPLARY, INCIDENTAL, SPECIAL, OR PUNITIVE DAMAGES, INCLUDING LOST PROFIT, LOST REVENUE, LOSS OF DATA, OR OTHER DAMAGES ARISING FROM YOUR USE OF THE SERVICES, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OUR LIABILITY TO YOU FOR ANY CAUSE WHATSOEVER WILL AT ALL TIMES BE LIMITED TO THE LESSER OF THE AMOUNT PAID, IF ANY, BY YOU TO US DURING THE SIX (6) MONTH PERIOD PRIOR TO ANY CAUSE OF ACTION ARISING.</p>

    <hr class="section-divider">

    <h2 id="indemnification">15. Indemnification</h2>
    <p>You agree to defend, indemnify, and hold us harmless, including our subsidiaries, affiliates, and all of our respective officers, agents, partners, and employees, from and against any loss, damage, liability, claim, or demand made by any third party due to or arising out of: (1) use of the Services; (2) breach of these Legal Terms; (3) any breach of your representations and warranties; (4) your violation of the rights of a third party; or (5) any overt harmful act toward any other user of the Services.</p>

    <hr class="section-divider">

    <h2 id="userdata">16. User Data</h2>
    <p>We will maintain certain data that you transmit to the Services for the purpose of managing the performance of the Services. Although we perform regular routine backups of data, you are solely responsible for all data that you transmit or that relates to any activity you have undertaken using the Services. You agree that we shall have no liability to you for any loss or corruption of any such data.</p>

    <hr class="section-divider">

    <h2 id="electronic">17. Electronic Communications, Transactions, and Signatures</h2>
    <p>Visiting the Services, sending us emails, and completing online forms constitute electronic communications. You consent to receive electronic communications, and you agree that all agreements, notices, disclosures, and other communications we provide to you electronically satisfy any legal requirement that such communication be in writing.</p>

    <hr class="section-divider">

    <h2 id="miscellaneous">18. Miscellaneous</h2>
    <p>These Legal Terms and any policies or operating rules posted by us on the Services constitute the entire agreement and understanding between you and us. Our failure to exercise or enforce any right or provision of these Legal Terms shall not operate as a waiver of such right or provision. These Legal Terms operate to the fullest extent permissible by law. We may assign any or all of our rights and obligations to others at any time. If any provision or part of a provision of these Legal Terms is determined to be unlawful, void, or unenforceable, that provision is deemed severable from these Legal Terms and does not affect the validity and enforceability of any remaining provisions.</p>

    <hr class="section-divider">

    <h2 id="contact">19. Contact Us</h2>
    <p>In order to resolve a complaint regarding the Services or to receive further information regarding use of the Services, please contact us at:</p>
    <div class="contact-block">
      <p><strong>Jigged</strong></p>
      <p><a href="mailto:legal@jigged.app">legal@jigged.app</a></p>
    </div>
          `,
        }}
      />
    </LegalPageContainer>
  );
}
