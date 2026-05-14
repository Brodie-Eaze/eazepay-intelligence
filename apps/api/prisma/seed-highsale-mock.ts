/**
 * Seed 10 mock HighSale credit-data snapshots into credit_enrichments.
 *
 * Purpose: make the /highsale drill page useful out of the box so the
 * team can see what the real HighSale data feels like — score
 * distribution, qualification mix, adverse events, tradeline depth.
 *
 * Mirrors the real production write path (encryptPII, hashPII, full
 * column set) except it bypasses the HMAC route + idempotency check.
 * Safe to re-run: existing transaction_ids upsert no-op.
 *
 * Run with:
 *   pnpm --filter api db:seed:highsale-mock
 */
import { PrismaClient, Prisma, HighsaleVertical } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { encryptPII, hashPII } from '../src/shared/utils/encryption.js';

interface MockApplicant {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  vertical: HighsaleVertical;
  // Credit profile
  score: number;
  isQualifiedBnpl: boolean;
  fundingEstimateBnpl: number; // cents
  availableCredit: number; // cents
  totalCreditLimit: number; // cents
  utilization: number; // 0..1
  trendedIncome: number; // cents
  trendedDebt: number; // cents
  monthlyObligation: number; // cents
  rentPayment: number; // cents
  totalLines: number;
  revolvingLines: number;
  averageCreditAge: number;
  oldestCreditAge: number;
  latePayments: number;
  collections: number;
  chargeOffs: number;
  repos: number;
  foreclosures: number;
  bankruptcies: number;
  satisfactoryTradeLines: number;
  recentInquiries: number;
  dqReasons: string[];
  saleConfidence: number; // 0..1
  // Demographics
  demographics: {
    estimated_income: string;
    marital_status: string;
    occupation: string;
    education: string;
    gender: 'F' | 'M' | null;
    ethnicity: string | null;
    language: string;
  };
}

// 10 applicants spanning the full credit spectrum + the three BNPL
// verticals. Mix of qualified / declined to exercise both UI states.
const MOCKS: MockApplicant[] = [
  {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane.doe@example.com',
    phone: '+61400111222',
    dob: '01-01-1985',
    street: '123 Test St',
    city: 'Sydney',
    state: 'NSW',
    zip: '2000',
    vertical: HighsaleVertical.medpay,
    score: 720,
    isQualifiedBnpl: true,
    fundingEstimateBnpl: 750_000,
    availableCredit: 4_500_000,
    totalCreditLimit: 9_600_000,
    utilization: 0.42,
    trendedIncome: 9_500_000,
    trendedDebt: 1_200_000,
    monthlyObligation: 240_000,
    rentPayment: 200_000,
    totalLines: 12,
    revolvingLines: 7,
    averageCreditAge: 56,
    oldestCreditAge: 124,
    latePayments: 0,
    collections: 0,
    chargeOffs: 0,
    repos: 0,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 10,
    recentInquiries: 4,
    dqReasons: [],
    saleConfidence: 0.78,
    demographics: {
      estimated_income: '$80,000-$100,000',
      marital_status: 'Married',
      occupation: 'Nurse',
      education: 'Bachelors',
      gender: 'F',
      ethnicity: null,
      language: 'English',
    },
  },
  {
    firstName: 'Liam',
    lastName: 'Nguyen',
    email: 'liam.nguyen@example.com',
    phone: '+61400222333',
    dob: '03-14-1978',
    street: '88 Elizabeth St',
    city: 'Melbourne',
    state: 'VIC',
    zip: '3000',
    vertical: HighsaleVertical.tradepay,
    score: 785,
    isQualifiedBnpl: true,
    fundingEstimateBnpl: 1_500_000,
    availableCredit: 9_200_000,
    totalCreditLimit: 14_000_000,
    utilization: 0.18,
    trendedIncome: 14_500_000,
    trendedDebt: 1_800_000,
    monthlyObligation: 360_000,
    rentPayment: 250_000,
    totalLines: 18,
    revolvingLines: 9,
    averageCreditAge: 88,
    oldestCreditAge: 192,
    latePayments: 0,
    collections: 0,
    chargeOffs: 0,
    repos: 0,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 17,
    recentInquiries: 2,
    dqReasons: [],
    saleConfidence: 0.92,
    demographics: {
      estimated_income: '$140,000-$160,000',
      marital_status: 'Married',
      occupation: 'Electrician',
      education: 'Trade qualification',
      gender: 'M',
      ethnicity: null,
      language: 'English',
    },
  },
  {
    firstName: 'Olivia',
    lastName: 'Patel',
    email: 'olivia.patel@example.com',
    phone: '+61400333444',
    dob: '08-22-1992',
    street: '12 Adelaide Tce',
    city: 'Perth',
    state: 'WA',
    zip: '6000',
    vertical: HighsaleVertical.coachpay,
    score: 668,
    isQualifiedBnpl: true,
    fundingEstimateBnpl: 350_000,
    availableCredit: 1_200_000,
    totalCreditLimit: 3_400_000,
    utilization: 0.65,
    trendedIncome: 6_800_000,
    trendedDebt: 2_400_000,
    monthlyObligation: 320_000,
    rentPayment: 220_000,
    totalLines: 8,
    revolvingLines: 4,
    averageCreditAge: 38,
    oldestCreditAge: 76,
    latePayments: 1,
    collections: 0,
    chargeOffs: 0,
    repos: 0,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 6,
    recentInquiries: 6,
    dqReasons: [],
    saleConfidence: 0.61,
    demographics: {
      estimated_income: '$60,000-$80,000',
      marital_status: 'Single',
      occupation: 'Personal trainer',
      education: 'Bachelors',
      gender: 'F',
      ethnicity: null,
      language: 'English',
    },
  },
  {
    firstName: 'Marcus',
    lastName: 'Thompson',
    email: 'marcus.thompson@example.com',
    phone: '+61400444555',
    dob: '11-05-1970',
    street: '550 George St',
    city: 'Sydney',
    state: 'NSW',
    zip: '2000',
    vertical: HighsaleVertical.medpay,
    score: 812,
    isQualifiedBnpl: true,
    fundingEstimateBnpl: 2_500_000,
    availableCredit: 18_500_000,
    totalCreditLimit: 24_000_000,
    utilization: 0.09,
    trendedIncome: 24_000_000,
    trendedDebt: 2_100_000,
    monthlyObligation: 420_000,
    rentPayment: 0,
    totalLines: 24,
    revolvingLines: 11,
    averageCreditAge: 142,
    oldestCreditAge: 286,
    latePayments: 0,
    collections: 0,
    chargeOffs: 0,
    repos: 0,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 24,
    recentInquiries: 1,
    dqReasons: [],
    saleConfidence: 0.96,
    demographics: {
      estimated_income: '$200,000+',
      marital_status: 'Married',
      occupation: 'Anaesthetist',
      education: 'Postgraduate',
      gender: 'M',
      ethnicity: null,
      language: 'English',
    },
  },
  {
    firstName: 'Sophie',
    lastName: 'Anderson',
    email: 'sophie.anderson@example.com',
    phone: '+61400555666',
    dob: '06-30-1988',
    street: '15 Eagle St',
    city: 'Brisbane',
    state: 'QLD',
    zip: '4000',
    vertical: HighsaleVertical.tradepay,
    score: 702,
    isQualifiedBnpl: true,
    fundingEstimateBnpl: 600_000,
    availableCredit: 3_200_000,
    totalCreditLimit: 6_800_000,
    utilization: 0.36,
    trendedIncome: 8_400_000,
    trendedDebt: 1_500_000,
    monthlyObligation: 290_000,
    rentPayment: 210_000,
    totalLines: 11,
    revolvingLines: 6,
    averageCreditAge: 64,
    oldestCreditAge: 138,
    latePayments: 0,
    collections: 0,
    chargeOffs: 0,
    repos: 0,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 10,
    recentInquiries: 3,
    dqReasons: [],
    saleConfidence: 0.74,
    demographics: {
      estimated_income: '$80,000-$100,000',
      marital_status: 'Single',
      occupation: 'Plumber',
      education: 'Trade qualification',
      gender: 'F',
      ethnicity: null,
      language: 'English',
    },
  },
  {
    firstName: 'Daniel',
    lastName: 'Mitchell',
    email: 'daniel.mitchell@example.com',
    phone: '+61400666777',
    dob: '02-18-1995',
    street: '7 King William St',
    city: 'Adelaide',
    state: 'SA',
    zip: '5000',
    vertical: HighsaleVertical.coachpay,
    score: 582,
    isQualifiedBnpl: false,
    fundingEstimateBnpl: 0,
    availableCredit: 280_000,
    totalCreditLimit: 1_200_000,
    utilization: 0.78,
    trendedIncome: 5_400_000,
    trendedDebt: 2_800_000,
    monthlyObligation: 380_000,
    rentPayment: 195_000,
    totalLines: 6,
    revolvingLines: 3,
    averageCreditAge: 24,
    oldestCreditAge: 48,
    latePayments: 4,
    collections: 1,
    chargeOffs: 1,
    repos: 0,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 2,
    recentInquiries: 9,
    dqReasons: ['Recent delinquency', 'High utilization', 'Active collection'],
    saleConfidence: 0.31,
    demographics: {
      estimated_income: '$40,000-$60,000',
      marital_status: 'Single',
      occupation: 'Hospitality',
      education: 'High school',
      gender: 'M',
      ethnicity: null,
      language: 'English',
    },
  },
  {
    firstName: 'Aisha',
    lastName: 'Khan',
    email: 'aisha.khan@example.com',
    phone: '+61400777888',
    dob: '09-09-1990',
    street: '200 Smith St',
    city: 'Fitzroy',
    state: 'VIC',
    zip: '3065',
    vertical: HighsaleVertical.medpay,
    score: 748,
    isQualifiedBnpl: true,
    fundingEstimateBnpl: 1_000_000,
    availableCredit: 6_100_000,
    totalCreditLimit: 11_000_000,
    utilization: 0.24,
    trendedIncome: 11_500_000,
    trendedDebt: 1_650_000,
    monthlyObligation: 310_000,
    rentPayment: 240_000,
    totalLines: 14,
    revolvingLines: 7,
    averageCreditAge: 72,
    oldestCreditAge: 156,
    latePayments: 0,
    collections: 0,
    chargeOffs: 0,
    repos: 0,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 13,
    recentInquiries: 2,
    dqReasons: [],
    saleConfidence: 0.86,
    demographics: {
      estimated_income: '$110,000-$140,000',
      marital_status: 'Married',
      occupation: 'Physiotherapist',
      education: 'Postgraduate',
      gender: 'F',
      ethnicity: null,
      language: 'English',
    },
  },
  {
    firstName: 'James',
    lastName: 'Wilson',
    email: 'james.wilson@example.com',
    phone: '+61400888999',
    dob: '12-12-1982',
    street: '99 Hindmarsh Sq',
    city: 'Adelaide',
    state: 'SA',
    zip: '5000',
    vertical: HighsaleVertical.tradepay,
    score: 654,
    isQualifiedBnpl: true,
    fundingEstimateBnpl: 280_000,
    availableCredit: 900_000,
    totalCreditLimit: 2_600_000,
    utilization: 0.71,
    trendedIncome: 7_200_000,
    trendedDebt: 2_300_000,
    monthlyObligation: 340_000,
    rentPayment: 175_000,
    totalLines: 9,
    revolvingLines: 4,
    averageCreditAge: 44,
    oldestCreditAge: 96,
    latePayments: 2,
    collections: 0,
    chargeOffs: 0,
    repos: 0,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 7,
    recentInquiries: 5,
    dqReasons: [],
    saleConfidence: 0.54,
    demographics: {
      estimated_income: '$60,000-$80,000',
      marital_status: 'Married',
      occupation: 'Carpenter',
      education: 'Trade qualification',
      gender: 'M',
      ethnicity: null,
      language: 'English',
    },
  },
  {
    firstName: 'Charlotte',
    lastName: 'Rivera',
    email: 'charlotte.rivera@example.com',
    phone: '+61400999000',
    dob: '04-04-1998',
    street: '21 Brunswick St',
    city: 'Fortitude Valley',
    state: 'QLD',
    zip: '4006',
    vertical: HighsaleVertical.coachpay,
    score: 540,
    isQualifiedBnpl: false,
    fundingEstimateBnpl: 0,
    availableCredit: 0,
    totalCreditLimit: 400_000,
    utilization: 1.05,
    trendedIncome: 4_200_000,
    trendedDebt: 3_100_000,
    monthlyObligation: 420_000,
    rentPayment: 185_000,
    totalLines: 5,
    revolvingLines: 2,
    averageCreditAge: 18,
    oldestCreditAge: 36,
    latePayments: 6,
    collections: 2,
    chargeOffs: 2,
    repos: 1,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 1,
    recentInquiries: 11,
    dqReasons: ['Charge-off in last 24 months', 'Repo on file', 'Utilization over 100%'],
    saleConfidence: 0.18,
    demographics: {
      estimated_income: '$30,000-$45,000',
      marital_status: 'Single',
      occupation: 'Barista',
      education: 'High school',
      gender: 'F',
      ethnicity: null,
      language: 'English',
    },
  },
  {
    firstName: 'Ethan',
    lastName: 'Park',
    email: 'ethan.park@example.com',
    phone: '+61401000111',
    dob: '07-07-1986',
    street: '450 St Kilda Rd',
    city: 'Melbourne',
    state: 'VIC',
    zip: '3004',
    vertical: HighsaleVertical.medpay,
    score: 765,
    isQualifiedBnpl: true,
    fundingEstimateBnpl: 1_250_000,
    availableCredit: 8_400_000,
    totalCreditLimit: 12_000_000,
    utilization: 0.21,
    trendedIncome: 12_800_000,
    trendedDebt: 1_900_000,
    monthlyObligation: 290_000,
    rentPayment: 280_000,
    totalLines: 16,
    revolvingLines: 8,
    averageCreditAge: 78,
    oldestCreditAge: 164,
    latePayments: 0,
    collections: 0,
    chargeOffs: 0,
    repos: 0,
    foreclosures: 0,
    bankruptcies: 0,
    satisfactoryTradeLines: 15,
    recentInquiries: 2,
    dqReasons: [],
    saleConfidence: 0.89,
    demographics: {
      estimated_income: '$120,000-$140,000',
      marital_status: 'Married',
      occupation: 'Software engineer',
      education: 'Bachelors',
      gender: 'M',
      ethnicity: null,
      language: 'English',
    },
  },
];

function gradeFromScore(score: number): number {
  // 0..9 categorical bucketing, monotonic with score.
  if (score >= 800) return 9;
  if (score >= 760) return 8;
  if (score >= 720) return 7;
  if (score >= 680) return 6;
  if (score >= 640) return 5;
  if (score >= 600) return 4;
  if (score >= 560) return 3;
  if (score >= 520) return 2;
  return 1;
}

function deterministicTxnId(seed: string): string {
  // Generate a stable uuid-ish id from the email so re-runs upsert.
  const hex = Buffer.from(seed).toString('hex').padEnd(32, '0').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '7' + hex.slice(13, 16),
    'a' + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    console.log('[seed-highsale-mock] starting');

    // Resolve org ids per vertical. Verticals are 1:1 with launch-business slugs.
    const orgIds = new Map<HighsaleVertical, string>();
    for (const v of [
      HighsaleVertical.medpay,
      HighsaleVertical.tradepay,
      HighsaleVertical.coachpay,
    ]) {
      const org = await prisma.organization.findUnique({
        where: { slug: v },
        select: { id: true },
      });
      if (!org) {
        console.error(
          `[seed-highsale-mock] missing org slug=${v}; run db:seed:portfolio-orgs first`,
        );
        process.exit(1);
      }
      orgIds.set(v, org.id);
    }

    const now = Date.now();
    let inserted = 0;
    let replayed = 0;

    for (let i = 0; i < MOCKS.length; i++) {
      const m = MOCKS[i]!;
      const txnId = deterministicTxnId(m.email);
      const pulledAt = new Date(now - i * 3600_000); // spread across the last 10 hours

      const exists = await prisma.creditEnrichment.findUnique({
        where: { highsaleTransactionId: txnId },
        select: { id: true },
      });
      if (exists) {
        console.log(`  skip ${m.email} (already present txn=${txnId})`);
        replayed++;
        continue;
      }

      const fullName = `${m.firstName} ${m.lastName}`;
      const fullAddress = `${m.street}|${m.city}|${m.state}|${m.zip}`;
      const nameEnc = encryptPII(fullName);
      const emailEnc = encryptPII(m.email);
      const phoneEnc = encryptPII(m.phone);
      const dobEnc = encryptPII(m.dob);
      const addressEnc = encryptPII(fullAddress);

      const gradeVal = gradeFromScore(m.score);

      const orgId = orgIds.get(m.vertical)!;

      await prisma.creditEnrichment.create({
        data: {
          orgId,
          highsaleTransactionId: txnId,
          externalApplicationId: `APP-MOCK-${(i + 1).toString().padStart(4, '0')}`,
          vertical: m.vertical,
          pulledAt,

          consumerNameCiphertext: nameEnc.ciphertext,
          consumerEmailCiphertext: emailEnc.ciphertext,
          consumerEmailHash: hashPII(m.email),
          consumerPhoneCiphertext: phoneEnc.ciphertext,
          consumerPhoneHash: hashPII(m.phone),
          dateOfBirthCiphertext: dobEnc.ciphertext,
          dateOfBirthHash: hashPII(m.dob),
          addressCiphertext: addressEnc.ciphertext,
          verifiableIncomeCents: Math.round(m.trendedIncome * 0.85), // form-stated ~85% of trended
          rentPaymentCents: m.rentPayment,

          isFrozen: false,
          isNoHit: false,
          isAddressAppend: i % 4 === 0,
          isAddressNoHit: false,
          isInsufficientCreditData: false,

          score: m.score,
          creditLineGrade: gradeVal,
          revolvingLinesGrade: gradeVal,
          oldestAccountGrade: gradeVal,
          latePaymentsGrade: m.latePayments === 0 ? gradeVal : Math.max(1, gradeVal - 2),
          collectionsGrade: m.collections === 0 ? gradeVal : Math.max(1, gradeVal - 3),
          newLinesGrade: m.recentInquiries < 4 ? gradeVal : Math.max(1, gradeVal - 1),
          utilizationGrade: m.utilization < 0.3 ? gradeVal : Math.max(1, gradeVal - 2),
          recentInquiriesGrade: m.recentInquiries < 4 ? gradeVal : Math.max(1, gradeVal - 1),
          averageGrade: gradeVal,

          declineRate: new Prisma.Decimal((100 - m.score / 10) / 100),
          approvalRate: new Prisma.Decimal(m.score / 1000),

          personalRemainingInquiries: Math.max(0, 5 - m.recentInquiries),
          personalLoanRemainingInquiries: Math.max(0, 3 - m.recentInquiries),
          businessRemainingInquiries: 5,

          totalLines: m.totalLines,
          totalRevolvingLines: m.revolvingLines,
          availableCreditCents: m.availableCredit,
          averageCreditLimitCents: Math.round(m.totalCreditLimit / Math.max(1, m.totalLines)),
          totalCreditLimitCents: m.totalCreditLimit,
          oldestCreditAge: m.oldestCreditAge,
          averageCreditAge: m.averageCreditAge,
          totalInquiries: m.recentInquiries,
          utilization: new Prisma.Decimal(m.utilization.toFixed(4)),
          latePayments: m.latePayments,
          collections: m.collections,
          trendedIncomeCents: m.trendedIncome,
          trendedDebtCents: m.trendedDebt,

          isQualified: m.isQualifiedBnpl,
          dqReasons: m.dqReasons,
          confidenceScore: new Prisma.Decimal(m.saleConfidence.toFixed(4)),
          fundingEstimateCents: m.fundingEstimateBnpl,
          isQualifiedBnpl: m.isQualifiedBnpl,
          confidenceScoreBnpl: new Prisma.Decimal(m.saleConfidence.toFixed(4)),
          fundingEstimateBnplCents: m.fundingEstimateBnpl,
          isQualifiedConsumerLoan: m.isQualifiedBnpl && m.score >= 660,
          fundingEstimateConsumerLoanCents:
            m.isQualifiedBnpl && m.score >= 660 ? Math.round(m.fundingEstimateBnpl * 2) : 0,

          numSatisfactoryTradeLines: m.satisfactoryTradeLines,
          numTradeLinesOpenedInLast6Months: Math.min(m.totalLines, 2),
          monthsSinceMostRecentDelinquency:
            m.latePayments > 0 ? 6 : Math.max(24, m.oldestCreditAge),
          numPrBankruptciesInLast24Months: m.bankruptcies,
          totalMonthlyObligationCents: m.monthlyObligation,
          numThirdPartyCollectionsWithBalance: m.collections,
          numOpenHomeEquityLoanTrades: 0,
          totalCreditUnionCreditLinesInLast12Months: Math.min(m.totalLines, 2),
          totalBalanceOfOpenCreditUnionTradeLinesInLast12MonthsCents: Math.round(
            m.totalCreditLimit * 0.1,
          ),
          monthsSinceMostRecentCreditUnionTradeOpened: 12,
          totalBalanceOfOpenRevolvingTradesInLast12MonthsCents: Math.round(
            m.totalCreditLimit * m.utilization,
          ),
          utilizationOfOpenRevolvingTradesInLast12Months: new Prisma.Decimal(
            m.utilization.toFixed(4),
          ),
          numOfRepoTrades: m.repos,
          totalBalanceOfRepoTradesCents: m.repos > 0 ? 1_200_000 : 0,
          numOfRetailTrades: Math.min(m.totalLines, 2),
          numOfOpenRetailTrades: Math.min(m.totalLines, 2),
          numOfThirdPartyCollections: m.collections,
          numOfNonMedicalThirdPartyCollections: m.collections,
          numOfThirdPartyCollectionsInTheLast36Months: m.collections,
          numOfStudentLoanTrades: 1,
          numOfOpenStudentLoanTrades: 1,
          numOfSatisfactoryOpenStudentLoanTrades: m.latePayments === 0 ? 1 : 0,
          numOf90PlusDaysPastDueStudentLoans: 0,
          numOfAuthUserTrades: 0,
          numOpenUnsecuredInstallmentTrades: 2,
          totalOpenUnsecuredInstallmentTradesInLast12Months: 1,
          percentOfOpenUnsecuredInstallmentTradesGt75InLast12Months: new Prisma.Decimal(
            m.utilization > 0.75 ? '0.5000' : '0.0000',
          ),
          utilizationOfOpenUnsecuredVerifiedInstallmentTradesInLast12Months: new Prisma.Decimal(
            m.utilization.toFixed(4),
          ),

          numOfChargeOffs: m.chargeOffs,
          numOfRepos: m.repos,
          numOfForeclosures: m.foreclosures,

          saleConfidenceScore: new Prisma.Decimal(m.saleConfidence.toFixed(4)),

          estimatedIncomeBand: m.demographics.estimated_income,
          numberOfChildren: null,
          maritalStatus: m.demographics.marital_status,
          occupationGroup: null,
          occupation: m.demographics.occupation,
          education: m.demographics.education,
          businessOwner: null,
          gender: m.demographics.gender,
          netWorth: null,
          estimatedCurrentHomeValue: null,
          ethnicity: m.demographics.ethnicity,
          ethnicGroup: null,
          language: m.demographics.language,

          rawPayload: { mocked: true, source: 'seed-highsale-mock', seedIndex: i },
        },
      });

      inserted++;
      console.log(
        `  + ${m.email.padEnd(36)} ${m.vertical.padEnd(8)} score=${m.score} bnpl=${m.isQualifiedBnpl ? 'Y' : 'N'}`,
      );
    }

    console.log(
      `[seed-highsale-mock] done · inserted=${inserted} skipped=${replayed} of ${MOCKS.length}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed-highsale-mock] error:', err);
  process.exit(1);
});
