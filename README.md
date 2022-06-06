# ITGlue Expiries - Autotask Integration

This script is used to watch for IT Glue expiry workflows (for Domains and SSL Certificates) and handles ticket creation in Autotask. This script is designed to be ran in an Azure function. You then grab the URL of the Azure function and plug that into the Webhook field of the workflow in ITG. When an alert comes up, the script will create a new ticket in Autotask via the API. If the script cannot connect to the Autotask API, it will fallback to sending an email to an address of your choice.

### ITG Workflow Setup
To create a proper workflow in ITG:
- Create a new workflow with either the "Domain Expiration" or "SSL Expiration" trigger type. Set the "lead time" to how many days before expiry you want the notification.
- Choose the "Webhook" action type. Set the "Webhook URL" to the full URL of the Azure function. Use following JSON payload options:
    - resourceName: [resource_name]
    - resourceUrl: [resource_url]
    - resourceTimeToExpiry: [resource_time_to_expiry]
    - organizationName: [organization_name]
    - testType: [trigger_name]

### Script Configuration
- Setup an Autotask API account with access to READ Companies, Locations, Contracts & ConfigurationItems, and to READ/WRITE Tickets and TicketNotes. Fill in the Autotask configuration with API account details in local.settings.json.
- Setup an ITG API Key (it does not need password access), fill in the ITG API Key in local.settings.json. This should be created in ITG directly, do not use the ITG API Forwarder for this.
- Configure the Email forwarder details in local.settings.json. (See my Email Forwarder script.) This could also be configured to use something like SendGrid instead but the script may require minor modifications.
- Configure the default ticket options in local.settings.json. These are details on Queue ID, Issue Type, Sub Issue Type, and the Service Level Agreement ID that the new ticket will be created with.
- Push this to an Azure Function and ensure the environment variables get updated.
- Get the URL of the Azure Function and setup a workflow in ITG using the above setup instructions.