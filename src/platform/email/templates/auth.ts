import type { TemplateDescriptor } from "./types";

export const authDescriptors: TemplateDescriptor[] = [
  {
    key: "auth.member_login_link",
    name: "Login link (magic link)",
    category: "transactional",
    group: "auth",
    variables: [
      { name: "firstName", label: "Recipient first name", sampleValue: "Sam" },
      {
        name: "loginUrl",
        label: "Sign-in link URL",
        sampleValue: "https://hub.havenfreeclinic.com/login/verify?token=abc",
      },
    ],
    defaultSubject: "Your HAVEN Hub sign-in link",
    defaultBody:
      '<p>Hi {{ firstName }},</p><p>Use this link to sign in to HAVEN Hub. It expires in 30 minutes and can be used once.</p><p><a href="{{ loginUrl }}">Sign in to HAVEN Hub</a></p><p>If you did not request this, you can ignore this email.</p>',
  },
];
