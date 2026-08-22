const ROLE_LABELS = {
  super_admin: 'Super Admin',
  farm_manager: 'Farm Manager',
  billing_manager: 'Billing Manager',
  delivery_manager: 'Delivery Manager',
  support_agent: 'Support Agent',
};

const ROLE_SCOPES = {
  super_admin: 'Full access · all modules',
  farm_manager: 'Plots, crops, harvest, baskets',
  billing_manager: 'Payments, subscriptions, refunds',
  delivery_manager: 'Deliveries, cancellations',
  support_agent: 'Support tickets, notifications',
};

/** Sidebar / GET module access */
const ROLE_MODULES = {
  super_admin: [
    'dashboard',
    'members',
    'payments',
    'subscriptions',
    'plots',
    'crops',
    'baskets',
    'deliveries',
    'cancellations',
    'notifications',
    'support',
    'reports',
    'audit',
    'settings',
  ],
  farm_manager: ['dashboard', 'plots', 'crops', 'baskets', 'members', 'audit'],
  billing_manager: ['dashboard', 'members', 'payments', 'subscriptions', 'reports', 'audit'],
  delivery_manager: ['dashboard', 'deliveries', 'cancellations', 'members', 'baskets', 'audit'],
  support_agent: ['dashboard', 'members', 'notifications', 'support', 'audit'],
};

const WRITE_ROLES = {
  members: ['super_admin', 'billing_manager'],
  payments: ['super_admin', 'billing_manager'],
  subscriptions: ['super_admin', 'billing_manager'],
  plots: ['super_admin', 'farm_manager'],
  crops: ['super_admin', 'farm_manager'],
  baskets: ['super_admin', 'farm_manager'],
  deliveries: ['super_admin', 'delivery_manager'],
  cancellations: ['super_admin', 'delivery_manager'],
  notifications: ['super_admin', 'support_agent'],
  support: ['super_admin', 'support_agent'],
  reports: ['super_admin', 'billing_manager'],
  settings: ['super_admin'],
  plans: ['super_admin'],
};

const CROP_STAGES = ['planned', 'growing', 'flowering', 'fruiting', 'ready', 'harvested'];

const BASKET_STATUSES = ['draft', 'review', 'locked', 'published', 'packed'];

const DELIVERY_OPS = ['scheduled', 'packed', 'ready_dispatch', 'out', 'delivered'];

const PAYMENT_METHODS = ['upi', 'neft', 'imps', 'cash', 'bank_transfer', 'offline'];

const PAYMENT_CONTEXTS = ['membership', 'lease', 'renewal', 'delivery'];

const AUDIENCES = ['all_members', 'active_subscribers', 'pending_payments', 'renewal_due', 'individual'];

const AUDIENCE_LABELS = {
  all_members: 'All members',
  active_subscribers: 'Active subscribers',
  pending_payments: 'Pending payments',
  renewal_due: 'Renewal due',
  individual: 'Individual member',
};

const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

const COLLECTIBLE_STATUSES = ['pending', 'processing', 'failed'];

const FARMS_SEED = [
  { id: 'siv', name: 'Sivaganga Farm', region: 'Karaikudi, Sivaganga', farmer: 'Murugan V.', prefixes: ['sivaganga'] },
  { id: 'the', name: 'Periyakulam Farm', region: 'Periyakulam, Theni', farmer: 'Ravi C.', prefixes: ['theni'] },
  { id: 'pud', name: 'Pudukkottai Farm', region: 'Aranthangi, Pudukkottai', farmer: 'Gopal S.', prefixes: ['pudukkottai'] },
];

const CROP_STAGE_LABELS = {
  planned: 'Planned',
  growing: 'Growing',
  flowering: 'Flowering',
  fruiting: 'Fruiting',
  ready: 'Ready',
  harvested: 'Harvested',
};

const METHOD_LABELS = {
  upi: 'UPI',
  neft: 'NEFT',
  imps: 'IMPS',
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  offline: 'Offline',
  payment_request: 'Payment request',
  card: 'Card',
};

module.exports = {
  ROLE_LABELS,
  ROLE_SCOPES,
  ROLE_MODULES,
  WRITE_ROLES,
  CROP_STAGES,
  BASKET_STATUSES,
  DELIVERY_OPS,
  PAYMENT_METHODS,
  PAYMENT_CONTEXTS,
  AUDIENCES,
  AUDIENCE_LABELS,
  TICKET_STATUSES,
  COLLECTIBLE_STATUSES,
  FARMS_SEED,
  CROP_STAGE_LABELS,
  METHOD_LABELS,
};
