"""Customer import module configuration.

This module defines the import configuration for the customers table,
including schema, mapping patterns, and validation rules.
"""

from ..config import FieldDefinition, ImportModuleConfig


CUSTOMERS_CONFIG = ImportModuleConfig(
    module_name="customers",
    table_name="customers",
    schema={
        "name": FieldDefinition(
            name="name",
            type="string",
            required=True,
            description="Company/customer name",
            mapping_patterns=[
                r"^(name|company[_\s-]?name|customer[_\s-]?name|business[_\s-]?name)$",
                r"^(company|customer|client|vendor|account)[_\s-]?name$",
                r"^(full[_\s-]?name|legal[_\s-]?name|dba)$",
            ],
        ),
        "website": FieldDefinition(
            name="website",
            type="string",
            required=False,
            description="Company website URL",
            mapping_patterns=[
                r"^(website|web[_\s-]?site|url|web[_\s-]?address|homepage)$",
                r"^(company[_\s-]?website|www)$",
            ],
        ),
        "contact_name": FieldDefinition(
            name="contact_name",
            type="string",
            required=False,
            description="Primary contact person name",
            mapping_patterns=[
                r"^(contact[_\s-]?name|contact[_\s-]?person|primary[_\s-]?contact)$",
                r"^(contact|rep|representative)$",
                r"^(first[_\s-]?name|last[_\s-]?name)$",  # May need AI for first+last combo
            ],
        ),
        "contact_phone": FieldDefinition(
            name="contact_phone",
            type="string",
            required=False,
            description="Primary contact phone number",
            mapping_patterns=[
                r"^(contact[_\s-]?phone|phone[_\s-]?number|phone|telephone|tel)$",
                r"^(primary[_\s-]?phone|main[_\s-]?phone|work[_\s-]?phone|office[_\s-]?phone)$",
                r"^(mobile|cell|cell[_\s-]?phone)$",
            ],
        ),
        "contact_email": FieldDefinition(
            name="contact_email",
            type="string",
            required=False,
            description="Primary contact email address",
            mapping_patterns=[
                r"^(contact[_\s-]?email|email[_\s-]?address|email|e[_\s-]?mail)$",
                r"^(primary[_\s-]?email|main[_\s-]?email|work[_\s-]?email)$",
            ],
        ),
        "address_line1": FieldDefinition(
            name="address_line1",
            type="string",
            required=False,
            description="Street address line 1",
            mapping_patterns=[
                r"^(address[_\s-]?(line)?[_\s-]?1?|street[_\s-]?address|street)$",
                r"^(address|addr|mailing[_\s-]?address|shipping[_\s-]?address)$",
            ],
        ),
        "address_line2": FieldDefinition(
            name="address_line2",
            type="string",
            required=False,
            description="Street address line 2 (suite, unit, etc.)",
            mapping_patterns=[
                r"^(address[_\s-]?(line)?[_\s-]?2|street[_\s-]?address[_\s-]?2)$",
                r"^(suite|unit|apt|apartment|floor|building)$",
            ],
        ),
        "city": FieldDefinition(
            name="city",
            type="string",
            required=False,
            description="City name",
            mapping_patterns=[
                r"^(city|town|municipality|locality)$",
            ],
        ),
        "state": FieldDefinition(
            name="state",
            type="string",
            required=False,
            description="State or province",
            mapping_patterns=[
                r"^(state|province|region|st)$",
                r"^(state[_\s-]?province|state[_\s-]?code)$",
            ],
        ),
        "postal_code": FieldDefinition(
            name="postal_code",
            type="string",
            required=False,
            description="ZIP or postal code",
            mapping_patterns=[
                r"^(postal[_\s-]?code|post[_\s-]?code|zip[_\s-]?code|zip|postcode)$",
            ],
        ),
        "country": FieldDefinition(
            name="country",
            type="string",
            required=False,
            description="Country (defaults to USA)",
            mapping_patterns=[
                r"^(country|nation|country[_\s-]?code)$",
            ],
        ),
    },
    unique_fields=["name"],
    domain_hints=[
        "customer", "client", "vendor", "company", "business",
        "contact", "phone", "email", "address", "city", "state", "zip",
    ],
    default_values={
        "country": "USA",
    },
    company_id_field="company_id",
)
