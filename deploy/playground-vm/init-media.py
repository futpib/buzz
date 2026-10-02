#!/usr/bin/env python3
import json
from pathlib import Path
import time
import boto3
from botocore.exceptions import ClientError, EndpointConnectionError

env = dict((k, json.loads(v)) for k, v in (line.split('=', 1) for line in Path('/opt/buzz/config/relay.env').read_text().splitlines()))
s3 = boto3.client('s3', endpoint_url=env['BUZZ_S3_ENDPOINT'], aws_access_key_id=env['BUZZ_S3_ACCESS_KEY'], aws_secret_access_key=env['BUZZ_S3_SECRET_KEY'], region_name='us-east-1')
for attempt in range(60):
    try:
        s3.create_bucket(Bucket='buzz-media')
        break
    except ClientError as e:
        if e.response['Error']['Code'] in ['BucketAlreadyExists', 'BucketAlreadyOwnedByYou']:
            break
        raise
    except EndpointConnectionError:
        if attempt == 59:
            raise
        time.sleep(2)
print('Private media bucket ready')
